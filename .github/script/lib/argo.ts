import {shellNoErr, writeToTemp} from './util';
import {fetchHelmChart} from './helm';
import got from 'got';
import {parseAllDocuments} from 'yaml';

export interface IArgoApp {
  metadata: {
    name: string;
    labels: {
      application: string;
      'argocd.argoproj.io/instance': string;
      cluster: string;
      namespace: string;
      region: string;
    };
  };
  spec: {
    project: string;
    source: {
      path?: string;
      chart: string;
      helm: {
        releaseName: string;
        values?: string;
        valueFiles?: string[];
        parameters?: {name: string; value: string; forceString?: boolean}[];
      };
      repoURL: string;
      targetRevision: string;
    };
    destination: {
      name: string;
      namespace: string;
    };
  };
  status: {
    history: {
      deployedAt: string;
      id: number;
      revision: string;
    }[];
    operationState: {
      phase: string;
      message: string;
    };
    sync: {
      status: string;
      revision: string;
    };
  };
}

export async function buildEnvironmentList(): Promise<IArgoApp[]> {
  const environmentsString = (
    await shellNoErr('helm template ./appofapp', {cwd: '../../'})
  ).stdout;
  const environments = parseAllDocuments(environmentsString as string);
  return environments.map(env => env.toJSON());
}

export async function fetchHelmChartForArgoApp(app: IArgoApp): Promise<string> {
  const repo = app.spec.source.repoURL;
  const chart = app.spec.source.chart;
  const version = app.spec.source.targetRevision;
  return fetchHelmChart(repo, chart, version);
}

export async function renderArgoApp(
  env: IArgoApp,
  app: IArgoApp
): Promise<string> {
  const helmFolder = await fetchHelmChartForArgoApp(app);
  const valuesFilesArray = app.spec?.source?.helm?.valueFiles || [];
  const literalValues = app.spec?.source?.helm?.values;
  const parameters = app.spec?.source?.helm?.parameters;
  let args = '';
  if (literalValues) {
    const tmpValues = await writeToTemp('-values.yaml', literalValues);
    valuesFilesArray.push(tmpValues);
  }
  if (parameters) {
    args += parameters
      .map(p => {
        let arg = p.forceString ? '--set-string ' : '--set ';
        arg += `"${p.name}" `;
        arg += `"${p.value}"`;
      })
      .join(' ');
  }
  args = valuesFilesArray.map(v => `-f ${v}`).join(' ') + args;
  return (
    await shellNoErr(
      `helm template . --name-template ${app.spec.source.helm.releaseName} --namespace ${app.spec.destination.namespace} --include-crds ${args}`,
      {cwd: helmFolder}
    )
  ).stdout as string;
}

export async function buildAppsForEnvironment(
  env: IArgoApp
): Promise<IArgoApp[]> {
  const path = env.spec.source.path;
  const helmValueFiles = env.spec.source.helm?.valueFiles;

  // render apps
  let args = '';
  if (helmValueFiles)
    args = helmValueFiles.map((f: string) => `-f ./${path}/${f}`).join(' ');

  const appsString = (
    await shellNoErr(`helm template ${args} ./${path}/`, {cwd: '../../'})
  ).stdout;

  const apps = parseAllDocuments(appsString as string);

  return apps.map(appDocument => appDocument.toJSON());
}

export async function getArgoLiveManifests(app: IArgoApp): Promise<any[]> {
  try {
    const response = got.get(
      `https://argocd.glops.io/api/v1/applications/${app.metadata.name}/manifests`,
      {headers: {Authorization: `Bearer ${process.env.ARGOCD_TOKEN}`}}
    );
    const body = (await response.json()) as any;
    return body.manifests.map(JSON.parse);
  } catch (e) {
    if (e instanceof got.HTTPError && e.response.statusCode === 404) {
      return [];
    } else {
      throw e;
    }
  }
}

export function getEnvironment(a: IArgoApp): {
  domain: string;
  project: string;
  region: string;
} {
  const {domain, project, region} =
    /(?<domain>\w+)-.+-(?<project>\w+)-(?<region>\w+)/.exec(a.metadata.name)!
      .groups!;
  return {
    domain,
    project,
    region,
  };
}
