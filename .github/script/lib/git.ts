import {exec} from 'child_process';
import {getBaseRef} from './github';
import {promisify} from 'util';

const execAsync = promisify(exec);
async function execAsyncOrThrow(command: string) {
  const results = await execAsync(command);
  if (results.stderr) {
    throw new Error(results.stderr);
  }
  return results;
}

export async function getChangedFiles(): Promise<string[]> {
  const baseRef = await getBaseRef();
  const diffResults = await execAsyncOrThrow(
    `git --no-pager diff --name-only ${baseRef.sha}`
  );
  return diffResults.stdout.split('\n');
}

export async function readFileAtBase(file: string | null) {
  const baseRef = await getBaseRef();
  const original = await execAsyncOrThrow(
    `git --no-pager show ${baseRef.sha}:${file}`
  );
  return original.stdout;
}
