import {readFile, readdir} from 'fs';
import {parse} from 'yaml';
import {promisify} from 'util';
import {resolve} from 'path';

export const ENVIRONMENT_FILES_REGEX = () =>
  /^(?<domain>krona|gl)\/values-(?<project>\w+)\.yaml$/g;

export enum Domain {
  Greenlight = 'gl',
  Krona = 'krona',
}

export interface IEnvironmentFile {
  project: string;
  source: {
    repo: string;
  };
  destinations: Array<{
    cluster: string;
    namespace: string;
    region: string;
  }>;
  syncPolicy?: unknown;
  options?: {
    ignoreStartupProbe: boolean;
  };
  common?: {
    values: unknown;
  };
  applications: Array<{
    name: string;
    /**
     * If not set, will default to `source.repo`
     */
    repo?: string;
    version: string;
    value?: unknown;
  }>;
}

const readFileAsync = promisify(readFile);
const readdirAsync = promisify(readdir);

/**
 * @param file File path relative to the root of the repo
 * @returns The contents of the file
 */
export async function readLocalFile(file: string | null) {
  if (file === null)
    throw new Error('cannot read local file: local file is null');
  return (await readFileAsync(resolve('../../', file))).toString();
}

export function applicationNameToRepo(applicationName: string): string {
  switch (applicationName) {
    case 'configmap':
      return 'helm';
    case 'commander':
      return 'commander-api';
    case 'experimentation-id':
      return 'experimentation-id-service';
    case 'sealed-secrets':
      return 'helm';
    default:
      return applicationName;
  }
}

export function refFromVersion(version: string): string {
  const matchesVersionSha = /^(?<version>[\d.]+)-(?<sha>[0-9a-f]{7})$/g.exec(
    version
  );
  if (matchesVersionSha !== null) {
    return matchesVersionSha.groups?.sha ?? '';
  }

  return `v${version}`;
}

export async function getAllEnvironmentFiles() {
  const domains = await Promise.all(
    Object.values(Domain).map(
      async domain =>
        [domain as string, await readdirAsync(`../../${domain}`)] as [
          string,
          string[]
        ]
    )
  );
  const environmentFileNames = domains
    .reduce(
      (a, c) => a.concat(c[1].map(f => `${c[0]}/${f}`)),
      new Array<string>()
    )
    .filter(f => ENVIRONMENT_FILES_REGEX().test(f));
  return await Promise.all(
    environmentFileNames.map(
      async fn =>
        [
          ENVIRONMENT_FILES_REGEX().exec(fn)?.groups,
          parse(await readLocalFile(fn)),
        ] as [{domain?: string; project?: string}, IEnvironmentFile]
    )
  );
}
