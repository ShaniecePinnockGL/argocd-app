import {mkdtempSync} from 'fs';
import {shellNoErr} from './util';
import {tmpdir} from 'os';

export async function fetchHelmChart(
  repo: string,
  chart: string,
  version: string
): Promise<string> {
  const tmpDir = mkdtempSync(tmpdir() + '/helm');
  let cmd = 'helm pull';
  if (repo.startsWith('https://greenlight.jfrog.io/artifactory/')) {
    cmd += ` --username "${process.env.HELM_USERNAME}" --password "${process.env.HELM_PASSWORD}"`;
  }
  cmd += ` --repo "${repo}" "${chart}" --version "${version}" --untar --destination ${tmpDir}`;
  await shellNoErr(cmd);
  return tmpDir + `/${chart}`;
}
