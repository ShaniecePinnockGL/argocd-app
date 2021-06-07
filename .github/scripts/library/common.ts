import { resolve } from 'path';
import { readFile } from 'fs';
import { promisify } from 'util';

export const ENVIRONMENT_FILES_REGEX = /^(?<domain>krona|gl)\/values-(?<project>\w+)\.yaml$/g

export interface IEnvironmentFile {
    project: string,
    source: {
        repo: string
    },
    destinations: Array<{
        cluster: string,
        namespace: string,
        region: string
    }>,
    syncPolicy?: unknown
    options?: {
        ignoreStartupProbe: boolean
    },
    common?: {
        values: unknown
    }
    applications: Array<{
        name: string,
        /**
         * If not set, will default to `source.repo`
         */
        repo?: string,
        version: string,
        value?: unknown
    }>
}


const readFileAsync = promisify(readFile)
/**
 * @param file File path relative to the root of the repo
 * @returns The contents of the file
 */
export async function readLocalFile(file: string) {
    const contents = await readFileAsync(resolve('../../', file));
    return contents.toString();
}


export async function applicationNameToRepo(applicationName: string) {
    switch(applicationName) {
        case "commander": return "commander-api";
        case "experimentation-id": return "experimentation-id-service";
        default: return applicationName;
    }
}

export async function refFromVersion(version: string) {
    const matchesVersionSha = /^(?<version>[\d\.]+)-(?<sha>[0-9a-f]{7})$/g.exec(version);
    if (matchesVersionSha != null) {
        return matchesVersionSha.groups.sha
    }
    
    return `v${version}`;
}