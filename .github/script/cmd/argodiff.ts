import * as core from '@actions/core';
import * as yaml from 'yaml';
import * as deepDiff from 'deep-object-diff';
import {diffYAMLResource} from '../lib/util';
import {
  buildAppsForEnvironment,
  buildEnvironmentList,
  getArgoLiveManifests,
  IArgoApp,
  renderArgoApp,
} from '../lib/argo';
import {
  createOrUpdateCommentWithFooter,
  deleteCommentWithFooterIfExists,
} from '../lib/github';

// 65535 minus a 5000 character buffer.
const MAX_COMMENT_SIZE = 65535 - 5000;

const footer =
  '> This application diff was automatically generated by a Github Actions Workflow based on information provided in this PR. If this message is inaccurate, please reach out on the #team-tools-help channel\n';

async function splitResourcesByName(
  env: IArgoApp,
  app: IArgoApp,
  resources: any[]
) {
  return resources.reduce((map, res) => {
    if (res === null) return map; // sometimes we have missing resources
    const apiVersion: string = res.apiVersion;
    const kind: string = res.kind;
    const resourceName: string = res.metadata.name;
    res.metadata.namespace = app.spec.destination.namespace;

    res.metadata.labels = res.metadata.labels || {};
    res.metadata.labels['argocd.argoproj.io/instance'] = app.metadata.name;

    map[`${apiVersion}/${kind} ${resourceName}`] = yaml
      .stringify(res)
      .toString();
    return map;
  }, {} as any);
}

async function getArgoDiff(
  env: IArgoApp,
  localApp: IArgoApp | undefined,
  remoteApp: IArgoApp | undefined
) {
  let newResourcesByName: any = {};
  let oldResourcesByName: any = {};

  if (localApp) {
    const localManifestsString = await renderArgoApp(env, localApp);
    const helmManifests = yaml
      .parseAllDocuments(localManifestsString)
      .map(doc => doc.toJSON());
    newResourcesByName = await splitResourcesByName(
      env,
      localApp,
      helmManifests
    );
  }

  if (remoteApp) {
    const remoteManifests = await getArgoLiveManifests(remoteApp);
    oldResourcesByName = await splitResourcesByName(
      env,
      remoteApp,
      remoteManifests
    );
  }

  const diff = deepDiff.diff(oldResourcesByName, newResourcesByName) as any;
  const diffs = await Promise.all(
    Object.keys(diff).map(async key => {
      const colorDiff = await diffYAMLResource(
        oldResourcesByName[key] || '',
        newResourcesByName[key] || '',
        true
      );
      const diff = await diffYAMLResource(
        oldResourcesByName[key] || '',
        newResourcesByName[key] || '',
        false
      );
      const toReturn = {
        resource: key,
        diff,
        colorDiff,
        header: '',
      };
      toReturn.header += `====${'='.repeat(key.length)}====\n`;
      toReturn.header += `=== ${key} ===\n`;
      toReturn.header += `====${'='.repeat(key.length)}====`;
      return toReturn;
    })
  );
  return diffs.filter(d => d.diff);
}

async function diffApps(
  env: IArgoApp,
  localApps: IArgoApp[],
  remoteApps: IArgoApp[]
) {
  const localAppsCopy: IArgoApp[] = JSON.parse(JSON.stringify(localApps));
  const remoteAppsCopy: IArgoApp[] = JSON.parse(JSON.stringify(remoteApps));

  const processAppList = (apps: any[]) => {
    return apps.reduce((map, app) => {
      // ignore this. It's set by argo after deploy, and completely unnecessary.
      delete app.metadata.labels['argocd.argoproj.io/instance'];

      map[app.metadata.name] = app;
      return map;
    }, {});
  };
  // json stringify and parse is to copy the objects so that we can mutate them.
  const localAppsByName = processAppList(localAppsCopy);
  const remoteAppsByName = processAppList(remoteAppsCopy);

  return deepDiff.diff(remoteAppsByName, localAppsByName);
}

async function processEnv(env: IArgoApp) {
  const localApps = await buildAppsForEnvironment(env);
  const remoteApps = await getArgoLiveManifests(env);
  const diff: {[appName: string]: any} = await diffApps(
    env,
    localApps,
    remoteApps
  );
  return await Promise.all(
    Object.keys(diff).map(async (appName: string) => {
      const localApp = localApps.find(a => a.metadata.name === appName);
      const remoteApp = localApps.find(a => a.metadata.name === appName);
      const helmDiff = await getArgoDiff(env, localApp, remoteApp);
      return {appName: appName, appDiff: helmDiff};
    })
  );
}

async function main() {
  let markdown = '## Kubernetes Resource Changes for PR:\n';
  markdown += `[Click Here for a Detailed List of Changes](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n\n`;
  let markdownBody = '';

  let envDiffs = await Promise.all(
    (
      await buildEnvironmentList()
    ).map(async env => {
      try {
        const appDiffs = await processEnv(env);
        return {envName: env.metadata.name, appDiffs: appDiffs};
      } catch (e) {
        console.error(e);
        core.error(`Failed to process env: ${env.metadata.name}`);
        markdown += `:exclamation: **${env.metadata.name}**: ${
          (e as Error).message
        }\n`;
        return {envName: env.metadata.name, appDiffs: []};
      }
    })
  );

  // filter out envs with no changes, and sort the ones that remain.
  envDiffs = envDiffs
    .filter(env => env.appDiffs.length > 0)
    .sort((env1, env2) => env1.envName.localeCompare(env2.envName));

  if (envDiffs.length === 0) {
    core.info('No Kubernetes Changes Detected');
    await deleteCommentWithFooterIfExists(footer);
    return;
  } else {
    core.info('Kubernetes Changes Found');
  }

  for (const envDiff of envDiffs) {
    envDiff.appDiffs.sort((app1, app2) =>
      app1.appName.localeCompare(app2.appName)
    );
    if (envDiff.appDiffs.length > 0) {
      markdownBody += `\n### ${envDiff.envName}`;
      for (const appDiff of envDiff.appDiffs) {
        markdownBody += `\n  - **${appDiff.appName}**\n`;
        core.startGroup(`ENV: ${envDiff.envName}\tAPP: ${appDiff.appName}`);
        for (const resource of appDiff.appDiff) {
          console.log(resource.header);
          console.log(resource.colorDiff + '\n\n');
          // please don't touch the whitespace here. Markdown is very finicky.
          markdownBody += `
    - <details><summary>${resource.resource}</summary>
  
      \`\`\`
      ${resource.diff.replace(/\n/g, '\n      ')}
      \`\`\`

      </details>
`;
        }
        core.endGroup();
      }
    }
  }
  if (
    footer.length + markdown.length + markdownBody.length >=
    MAX_COMMENT_SIZE
  ) {
    markdown +=
      '**There were too many changes to view inline. Use the link above to view the full output.**';
  } else {
    markdown += markdownBody;
  }
  await createOrUpdateCommentWithFooter(markdown, footer);
}

main().catch((err: Error) => {
  core.setFailed(err);
});
