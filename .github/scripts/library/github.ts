import { context, getOctokit } from '@actions/github';
import { getInput, setSecret, debug, setFailed } from '@actions/core';

const token = getInput('token');
setSecret(token); // mask it from any accidental output

const rawOcto = getOctokit(token)
const octokit = rawOcto.rest;

const currentPR = octokit.pulls.get({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.issue.number,
}).catch((e: Error) => {
    setFailed("Pull request not found. " + e.stack);
    process.exit(1)
})

export async function getCurrentPR() {
    const response = await currentPR
    return response.data;
}

export async function getBaseRef() {
    const pr = await getCurrentPR()
    return pr.base;
}

export async function compareCommits(repository: string, from: string, to: string) {
    debug('Comparing commits for ' + repository + ' from ' + from + ' to ' + to)
    const [owner, repo] = repository.split('/', 2);
    const results = await octokit.repos.compareCommits({
        owner,
        repo,
        base: from,
        head: to
    })
    return results.data;
}

export async function getAllComments() {
    const response = await octokit.issues.listComments({
        owner: context.repo.owner,
        issue_number: context.issue.number,
        repo: context.repo.repo,
    });

    return response.data;
}

export async function createComment(body: string) {
    const response = await octokit.issues.createComment({
        owner: context.repo.owner,
        issue_number: context.issue.number,
        repo: context.repo.repo,
        body: body
    })
    return response.data;
}

export async function editComment(commentId: number, body: string) {
    const response = await octokit.issues.updateComment({
        owner: context.repo.owner,
        issue_number: context.issue.number,
        repo: context.repo.repo,
        comment_id: commentId,
        body
    })

    return response.data;
}

export async function getUser() {
    const response = await rawOcto.request('GET /user')
    return response.data
}