import { parse } from 'yaml';
import * as core from '@actions/core';

import { compareCommits, getRepository } from '../library/github'
import { postMessage } from '../library/slack'
import { applicationNameToRepo, Domain, IEnvironmentFile, readLocalFile, refFromVersion } from '../library/common'

const LATEST_SELECTOR = '>= 0.0.0-0';

async function computeDrift(domain: Domain, leadEnvironment: string, laggingEnvironment: string) {
    const [lead, lag] = await Promise.all(
        [leadEnvironment, laggingEnvironment]
            .map(async e => parse(await readLocalFile(`${domain}/values-${e}.yaml`)) as IEnvironmentFile)
    )

    const changes = new Array<{ application: string, laggingVersion?: string, leadingVersion?: string }>();

    for (const laggingApp of lag.applications) {
        const leadingApp = lead.applications.find(app => app.name == laggingApp.name);

        if (leadingApp?.version == laggingApp.version) continue;

        changes.push({
            application: laggingApp.name,
            laggingVersion: laggingApp.version,
            leadingVersion: leadingApp?.version
        })
    }

    const changesWithCommits = await Promise.all(changes.map(async (change) => {
        if (!change.leadingVersion) {
            return { ...change, changes: null };
        }
        const repo = await applicationNameToRepo(change.application)
        if (!repo) {
            return null;
        }

        const fullPathRepo = `GreenlightMe/${repo}`;

        let fromRef = await refFromVersion(change.laggingVersion);
        let toRef = await refFromVersion(change.leadingVersion);

        if (change.laggingVersion == LATEST_SELECTOR || change.leadingVersion == LATEST_SELECTOR) {
            try {
                const repository = await getRepository(fullPathRepo);
                if (change.laggingVersion == LATEST_SELECTOR) fromRef = repository.default_branch
                if (change.leadingVersion == LATEST_SELECTOR) toRef = repository.default_branch
            }
            catch (e) {
                core.warning('Could not get repository for ' + fullPathRepo + ' - ' + e.stackTrace);
            }
        }

        try {
            const commits = await compareCommits(fullPathRepo, fromRef, toRef);
            return {
                ...change,
                changes: commits
            }
        }
        catch (e) {
            core.warning(`Error getting commits for ${fullPathRepo}: ${fromRef}...${toRef}`)
            return { ...change, changes: null };
        }
    }))

    const filteredChangesWithCommits = changesWithCommits.filter((c) => c != null)

    if (filteredChangesWithCommits.length == 0) {
        return null;
    }

    let markdown = `\`${laggingEnvironment}\` has ${filteredChangesWithCommits.length} services that are behind \`${leadEnvironment}\`\n`
    for (const changeWithCommits of filteredChangesWithCommits) {
        if (changeWithCommits.changes) {
            if (changeWithCommits.changes.status == 'ahead') {
                markdown += `* *${changeWithCommits.application}* is behind by <${changeWithCommits.changes.html_url}|${changeWithCommits.changes.ahead_by} changes>.\n`
            }
            else if (changeWithCommits.changes.status == 'behind') {
                markdown += `* *${changeWithCommits.application}* is ahead by <${changeWithCommits.changes.html_url}|${changeWithCommits.changes.behind_by} changes>.\n`
            }
            else if (changeWithCommits.changes.status == 'diverged') {
                markdown += `* *${changeWithCommits.application}* has <${changeWithCommits.changes.html_url}|diverged history>.\n`
            }
        }
        else {
            markdown += `* *${changeWithCommits.application}* is on \`${changeWithCommits.laggingVersion}\` in \`${laggingEnvironment}\` and \`${changeWithCommits.leadingVersion}\` in \`${leadEnvironment}\`\n`
        }
    }
    return markdown;
}

async function main() {
    const drift = await computeDrift(Domain.Greenlight, 'dev', 'prod')
    await postMessage('backend-release', drift)
    console.log(drift);
}

main().catch((err: Error) => {
    core.error(err.stack)
    core.setFailed(err)
})
