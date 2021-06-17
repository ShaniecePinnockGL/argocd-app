import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import * as util from 'util';

export const shell = util.promisify(cp.exec);

let tempCounter = 0;
export function writeToTemp(suffix: string, contents: string) {
  const tmp =
    os.tmpdir() + '/' + new Date().getMilliseconds() + tempCounter++ + suffix;
  fs.writeFileSync(tmp, contents);
  return tmp;
}

export async function diffYAMLResource(
  oldResource: string,
  newResource: string,
  color?: boolean
) {
  const oldFile = writeToTemp('-old.yaml', oldResource);
  const newFile = writeToTemp('-new.yaml', newResource);
  return (
    await shell(
      `dyff between --omit-header -c ${
        color ? 'on' : 'off'
      } -t off ${oldFile} ${newFile}`
    )
  ).stdout.trim();
}

export async function shellNoErr(cmd: string, opts?: cp.ExecOptions) {
  return await shell(cmd, opts).catch();
}
