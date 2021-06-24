import * as util from 'util';
import {ExecOptions, exec} from 'child_process';
import {tmpdir} from 'os';
import {writeFileSync} from 'fs';

export const shell = util.promisify(exec);

let tempCounter = 0;

export function writeToTemp(suffix: string, contents: string) {
  const tmp =
    tmpdir() + '/' + new Date().getMilliseconds() + tempCounter++ + suffix;
  writeFileSync(tmp, contents);
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

export function createSanitizer(...toRemove: string[]) {
  return (input: string) => {
    return toRemove.reduce((str, itemToRem) => {
      return str.split(itemToRem).join('<...>');
    }, input);
  };
}

export const defaultSanitizer = createSanitizer(
  process.env.ARGOCD_TOKEN!,
  process.env.GREENLIGHTBOT_PAT!,
  process.env.HELM_PASSWORD!,
  process.env.SLACK_TOKEN!
);

export async function shellNoErr(cmd: string, opts?: ExecOptions) {
  return await shell(cmd, opts).catch();
}
