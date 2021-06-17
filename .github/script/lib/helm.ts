import {shellNoErr} from './util';
import * as fs from 'fs';
import * as os from 'os';

export async function fetchHelmChart(
  repo: string,
  chart: string,
  version: string
): Promise<string> {
  const tmpDir = fs.mkdtempSync(os.tmpdir() + '/helm');
  let cmd = 'helm pull';
  if (repo.startsWith('https://greenlight.jfrog.io/artifactory/')) {
    cmd +=
      ' --username "${process.env.HELM_USERNAME}" --password "${process.env.HELM_PASSWORD}"';
  }
  cmd += ` --repo "${repo}" "${chart}" --version "${version}" --untar --destination ${tmpDir}`;
  await shellNoErr(cmd);
  return tmpDir + `/${chart}`;
}
