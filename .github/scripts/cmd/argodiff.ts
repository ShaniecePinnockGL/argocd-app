import * as core from '@actions/core';
import yaml from 'yaml';
//@ts-ignore There's no typings for deep-object-diff
import * as deepDiff from 'deep-object-diff';
import { diffYAMLResource } from '../library/util';
import { buildEnvironmentList, buildAppsForEnvironment, getArgoLiveManifests, renderArgoApp, IArgoApp } from '../library/argo';
import { createOrUpdateCommentWithFooter } from '../library/github';

const footer = '> This application diff was automatically generated by a Github Actions Workflow based on information provided in this PR. If this message is inaccurate, please reach out on the #team-tools-help channel\n'

async function splitResourcesByName(env: IArgoApp, app: IArgoApp, resources: any[]) {
  return resources
    .reduce((map, res) => {
      if (res === null) return map; // sometimes we have missing resources
      const apiVersion: string = res.apiVersion;
      const kind: string = res.kind;
      const resourceName: string = res.metadata.name;
      res.metadata.namespace = app.spec.destination.namespace;

      res.metadata.labels = res.metadata.labels || {};
      res.metadata.labels['argocd.argoproj.io/instance'] = app.metadata.name;

      map[`${apiVersion}/${kind} ${resourceName}`] = yaml.stringify(res).toString();
      return map;
    }, {} as any);
}

async function getArgoDiff(env: IArgoApp, localApp: IArgoApp, remoteApp: IArgoApp) {
  let newResourcesByName: any = {};
  let oldResourcesByName: any = {};

  if (localApp) {
    let localManifestsString = await renderArgoApp(env, localApp);
    const helmManifests = yaml.parseAllDocuments(localManifestsString).map(doc => doc.toJSON());
    newResourcesByName = await splitResourcesByName(env, localApp, helmManifests);
  }

  if (remoteApp) {
    const remoteManifests = await getArgoLiveManifests(remoteApp);
    oldResourcesByName = await splitResourcesByName(env, remoteApp, remoteManifests);
  }

  const diff = deepDiff.diff(oldResourcesByName, newResourcesByName) as any;
  const diffs = await Promise.all(Object.keys(diff).map(async key => {
    const diff = await diffYAMLResource(oldResourcesByName[key] || '', newResourcesByName[key] || '')
    let toReturn = {
      resource: key,
      diff,
      header: ''
    };
    toReturn.header += `====${"=".repeat(key.length)}====\n`;
    toReturn.header += `=== ${key} ===\n`;
    toReturn.header += `====${"=".repeat(key.length)}====`;
    return toReturn;
  }))
  return diffs.filter(d => d.diff);
}

async function diffApps(env: IArgoApp, localApps: IArgoApp[], remoteApps: IArgoApp[]) {
  const localAppsCopy: IArgoApp[] = JSON.parse(JSON.stringify((localApps)));
  const remoteAppsCopy: IArgoApp[] = JSON.parse(JSON.stringify((remoteApps)));

  const processAppList = (apps: any[]) => {
    return apps.reduce((map, app) => {
      // ignore this. It's set by argo after deploy, and completely unnecessary.
      delete app.metadata.labels['argocd.argoproj.io/instance'];

      map[app.metadata.name] = app;
      return map;
    }, {});
  }
  // json stringify and parse is to copy the objects so that we can mutate them.
  const localAppsByName = processAppList(localAppsCopy);
  const remoteAppsByName = processAppList(remoteAppsCopy);

  const appDiff = deepDiff.diff(remoteAppsByName, localAppsByName);
  return appDiff;
}

async function processEnv(env: IArgoApp) {
  const localApps = await buildAppsForEnvironment(env)
  const remoteApps = await getArgoLiveManifests(env);
  const diff: { [appName: string]: any } = await diffApps(env, localApps, remoteApps);
  return await Promise.all(Object.keys(diff).map(async (appName: string) => {
    const localApp = localApps.find((a) => a.metadata.name === appName);
    const remoteApp = localApps.find((a) => a.metadata.name === appName);
    const helmDiff = await getArgoDiff(env, localApp, remoteApp);
    return { appName: appName, appDiff: helmDiff };
  }))
}

async function main() {

  let markdown = `## Kubernetes Resource Changes for PR:\n`
  markdown += `[Click Here for a Detailed List of Changes](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n\n`

  const envDiffs = await Promise.all((await buildEnvironmentList()).map(async env => {
    try {
      const appDiffs = await processEnv(env);
      return { envName: env.metadata.name, appDiffs: appDiffs };
    } catch (e) {
      console.error(e);
      core.error(`Failed to process env: ${env.metadata.name}`);
      markdown += `:exclamation: **${env.metadata.name}**: ${(e as Error).message}\n`;
      return { envName: env.metadata.name, appDiffs: [] };
    }
  }))

  envDiffs.sort((env1, env2) => env1.envName.localeCompare(env2.envName));
  for (const envDiff of envDiffs) {
    envDiff.appDiffs.sort((app1, app2) => app1.appName.localeCompare(app2.appName));
    if (envDiff.appDiffs.length > 0) {
      markdown += `\n### ${envDiff.envName}`;
      for (const appDiff of envDiff.appDiffs) {
        markdown += `\n- **${appDiff.appName}**\n`;
        core.startGroup(`ENV: ${envDiff.envName}\tAPP: ${appDiff.appName}`);
        for (const resource of appDiff.appDiff) {
          markdown += `\t- ${resource.resource}\n`
          console.log(resource.header);
          console.log(resource.diff + '\n\n');
        }
        core.endGroup();
      }
    }
  }
  markdown += '\n';
  await createOrUpdateCommentWithFooter(markdown, footer);
}

main().catch(e => {
  console.error(e);
  core.error(e);
  core.setFailed(e);
})