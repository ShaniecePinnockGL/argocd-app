import { shell, shellNoErr, writeToTemp } from "./util";
import * as fs from 'fs';
import * as os from 'os';

export async function fetchHelmChart(repo: string, chart: string, version: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(os.tmpdir() + '/helm');
  (await shellNoErr(`helm pull --username "${process.env.HELM_USERNAME}" --password "${process.env.HELM_PASSWORD}" --repo "${repo}" "${chart}" --version "${version}" --untar --destination ${tmpDir}`));
  return tmpDir + `/${chart}`;
}