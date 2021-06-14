import { shell, shellNoErr, writeToTemp } from "./util";
import * as yaml from 'yaml';
import * as fs from 'fs';
import got from 'got';
import { fetchHelmChart } from "./helm";

export interface IArgoApp {
  metadata: {
    name: string,
  }
  spec: {
    project: string,
    source: {
      path?: string,
      chart: string,
      helm: {
        releaseName: string,
        values?: string,
        valueFiles?: string[]
        parameters?: { name: string, value: string, forceString?: boolean }[],
      },
      repoURL: string,
      targetRevision: string,
    },
    destination: {
      name: string,
      namespace: string,
    }
  }
}

export async function buildEnvironmentList(): Promise<IArgoApp[]> {
  const environmentsString = (await shellNoErr('helm template ./appofapp', { cwd: '../../' })).stdout;
  const environments = yaml.parseAllDocuments(environmentsString);
  return environments.map(env => env.toJSON());
}

export async function fetchHelmChartForArgoApp(app: IArgoApp): Promise<string> {
  const repo = app.spec.source.repoURL;
  const chart = app.spec.source.chart;
  const version = app.spec.source.targetRevision;
  return fetchHelmChart(repo, chart, version);
}

export async function renderArgoApp(env: IArgoApp, app: IArgoApp): Promise<string> {
  const helmFolder = await fetchHelmChartForArgoApp(app);
  const valuesFilesArray = app.spec?.source?.helm?.valueFiles || [];
  const literalValues = app.spec?.source?.helm?.values;
  const parameters = app.spec?.source?.helm?.parameters;
  let args = ''
  if (literalValues) {
    const tmpValues = await writeToTemp('-values.yaml', literalValues);
    valuesFilesArray.push(tmpValues);
  }
  if (parameters) {
    args += parameters.map(p => {
      let arg = p.forceString ? '--set-string ' : '--set '
      arg += `"${p.name}" `;
      arg += `"${p.value}"`
    }).join(' ')
  }
  args = valuesFilesArray.map(v => `-f ${v}`).join(' ') + args;
  return (await shellNoErr(`helm template . --name-template ${app.spec.source.helm.releaseName} --namespace ${app.spec.destination.namespace} --include-crds ${args}`, { cwd: helmFolder })).stdout;
}

export async function buildAppsForEnvironment(env: IArgoApp): Promise<IArgoApp[]> {
  const envName = env.metadata?.name;
  const path = env.spec.source.path;
  const helmValueFiles = env.spec.source.helm?.valueFiles;

  // render apps
  let args = '';
  if (helmValueFiles) args = helmValueFiles.map((f: string) => `-f ./${path}/${f}`).join(' ');

  const appsString = (await shellNoErr(`helm template ${args} ./${path}/`, { cwd: '../../' })).stdout;

  const apps = yaml.parseAllDocuments(appsString);

  return apps.map(appDocument => appDocument.toJSON())
}

export async function getArgoLiveManifests(app: IArgoApp): Promise<any[]> {
  try {
    const response = (got.get(`https://argocd.glops.io/api/v1/applications/${app.metadata.name}/manifests`, { headers: { Authorization: `Bearer ${process.env.ARGOCD_TOKEN}` } }));
    const body = (await response.json() as any);
    const apps = body.manifests.map(JSON.parse);
    return apps;
  } catch (e) {
    if (e instanceof got.HTTPError && e.response.statusCode === 404) {
      return [];
    } else {
      throw e;
    }
  }
}