import {context, getOctokit} from '@actions/github';
import {setSecret, debug, info} from '@actions/core';
import {RestEndpointMethodTypes} from '@octokit/rest';

const token = process.env.GREENLIGHTBOT_PAT ?? '';
setSecret(token); // mask it from any accidental output

const rawOcto = getOctokit(token);
const octokit = rawOcto.rest;

let _currentPR: Promise<RestEndpointMethodTypes['pulls']['get']['response']>;

function currentPR() {
  if (_currentPR) return _currentPR;

  _currentPR = octokit.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
  });
  _currentPR.catch((e: Error) => {
    throw new Error('Pull request not found. ' + e.stack);
  });

  return _currentPR;
}

export async function getCurrentPR() {
  const {data} = await currentPR();
  return data;
}

export async function getBaseRef() {
  const pr = await getCurrentPR();
  return pr.base;
}

export async function compareCommits(
  repository: string,
  from: string,
  to: string
) {
  debug('Comparing commits for ' + repository + ' from ' + from + ' to ' + to);
  const [owner, repo] = repository.split('/', 2);
  const {data} = await octokit.repos.compareCommits({
    owner,
    repo,
    base: from,
    head: to,
  });
  return data;
}

export async function getCommit(repository: string, ref: string) {
  const [owner, repo] = repository.split('/', 2);
  const {data} = await octokit.repos.getCommit({
    owner,
    repo,
    ref,
  });
  return data;
}

export async function getAllComments() {
  const {data} = await octokit.issues.listComments({
    owner: context.repo.owner,
    issue_number: context.issue.number,
    repo: context.repo.repo,
  });

  return data;
}

export async function createOrUpdateCommentWithFooter(
  markdown: string,
  footer: string
) {
  info(
    'Getting all comments to see if I should create a new one or edit an existing one'
  );
  const allComments = await getAllComments();
  const possiblyExistingComment = allComments.find(c =>
    c.body?.includes(footer)
  );

  if (
    possiblyExistingComment &&
    (await getUser()).id === possiblyExistingComment.user?.id
  ) {
    info('Found existing comment to edit (' + possiblyExistingComment.id + ')');
    await editComment(possiblyExistingComment.id, markdown + footer);
  } else {
    info('Creating new comment');
    await createComment(markdown + footer);
  }
}

export async function deleteCommentWithFooterIfExists(footer: string) {
  info("Getting all comments to see if there's a comment to delete");
  const allComments = await getAllComments();
  const possiblyExistingComment = allComments.find(c =>
    c.body?.includes(footer)
  );

  if (
    possiblyExistingComment &&
    (await getUser()).id === possiblyExistingComment.user?.id
  ) {
    info(
      'Found existing comment to delete (' + possiblyExistingComment.id + ')'
    );
    await deleteComment(possiblyExistingComment.id);
  } else {
    info('No Comment to Delete');
  }
}

export async function createComment(body: string) {
  const {data} = await octokit.issues.createComment({
    owner: context.repo.owner,
    issue_number: context.issue.number,
    repo: context.repo.repo,
    body: body,
  });
  return data;
}

export async function editComment(commentId: number, body: string) {
  const {data} = await octokit.issues.updateComment({
    owner: context.repo.owner,
    issue_number: context.issue.number,
    repo: context.repo.repo,
    comment_id: commentId,
    body,
  });
  return data;
}

export async function deleteComment(commentId: number) {
  const {data} = await octokit.issues.deleteComment({
    owner: context.repo.owner,
    issue_number: context.issue.number,
    repo: context.repo.repo,
    comment_id: commentId,
  });
  return data;
}

export async function getUser() {
  const {data} = await rawOcto.request('GET /user');
  return data;
}

export async function getRepository(repository: string) {
  const [owner, repo] = repository.split('/', 2);
  const {data} = await octokit.repos.get({owner, repo});
  return data;
}

export async function createDeployment(
  repo: string,
  ref: string,
  environment: string
) {
  const {data} = await octokit.repos.createDeployment({
    owner: context.repo.owner,
    repo,
    ref,
    environment,
    required_contexts: [],
  });
  return data;
}

export type DeploymentState =
  | 'error'
  | 'failure'
  | 'inactive'
  | 'in_progress'
  | 'queued'
  | 'pending'
  | 'success';

export async function createDeploymentStatus(
  repo: string,
  deploymentId: number,
  state: DeploymentState
) {
  const {data} = await octokit.repos.createDeploymentStatus({
    owner: context.repo.owner,
    repo,
    deployment_id: deploymentId,
    state,
  });
  return data;
}
