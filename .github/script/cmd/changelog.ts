import * as types from '@octokit/openapi-types';

import {
  ENVIRONMENT_FILES_REGEX,
  IEnvironmentFile,
  applicationNameToRepo,
  getAllEnvironmentFiles,
  readLocalFile,
  refFromVersion,
} from '../lib/common';
import {
  compareCommits,
  createOrUpdateCommentWithFooter,
  deleteCommentWithFooterIfExists,
  getCommit,
  getCurrentPR,
  getReviews,
  isCollaborator,
  requestReviews,
} from '../lib/github';
import {info, warning, setFailed} from '@actions/core';
import {getChangedFiles, readFileAtBase} from '../lib/git';
import {defaultSanitizer} from '../lib/util';
import {parse} from 'yaml';

enum ChangeType {
  ADDED,
  MODIFIED,
  DELETED,
}

const footer =
  '> This changelog was automatically generated by a Github Actions Workflow based on information provided in this PR. If this message is inaccurate, please reach out on the #team-tools-help channel\n';

function getCommitsByAuthor(
  commits: Array<types.components['schemas']['commit']>
) {
  return commits.reduce((a, c) => {
    if (c.author) {
      if (!a.has(c.author.login)) {
        a.set(c.author.login, [c]);
      } else {
        a.set(c.author.login, a.get(c.author.login)!.concat(c));
      }
    }
    return a;
  }, new Map<string, Array<types.components['schemas']['commit']>>());
}

async function main() {
  // Get changed environment files
  const changedFiles = await getChangedFiles();

  const changedEnvironmentFiles = changedFiles
    .map(f => ENVIRONMENT_FILES_REGEX().exec(f))
    .filter(f => f !== null)
    .map(f => ({
      file: f![0],
      domain: f!.groups?.domain,
      project: f!.groups?.project,
      toString: () => `${f!.groups?.domain}/${f!.groups?.project}`,
    }));

  if (changedEnvironmentFiles.length === 0) {
    info('No changed environment files.');
    await deleteCommentWithFooterIfExists(footer);
    return;
  }

  if (changedEnvironmentFiles.length > 1) {
    throw new Error(
      'Only one environment can be updated at a time. Environments updated were ' +
        changedEnvironmentFiles.join(',')
    );
  }

  // Grab all environment files to use to report other versions in other environments further down
  const allEnvironmentFiles = await getAllEnvironmentFiles();

  const environmentFile = changedEnvironmentFiles[0];
  info('Getting changes for ' + environmentFile);

  const [original, current] = await Promise.all([
    readFileAtBase(environmentFile.file),
    readLocalFile(environmentFile.file),
  ]);

  const parsedOriginal = parse(original) as IEnvironmentFile;
  const parsedCurrent = parse(current) as IEnvironmentFile;

  const changes = new Array<{
    type: ChangeType;
    application: string;
    fromVersion?: string;
    toVersion?: string;
  }>();

  // Compute which applications have changed based on version numbers
  for (const originalApp of parsedOriginal.applications) {
    const currentApp = parsedCurrent.applications.find(
      a => originalApp.name === a.name
    );

    if (!currentApp) {
      info(`${originalApp.name} has been removed`);
      changes.push({
        type: ChangeType.DELETED,
        application: originalApp.name,
        fromVersion: originalApp.version,
      });
      continue;
    }

    if (currentApp.version !== originalApp.version) {
      info(
        `${originalApp.name} has been updated from ${originalApp.version} to ${currentApp.version}`
      );
      changes.push({
        type: ChangeType.MODIFIED,
        application: originalApp.name,
        fromVersion: originalApp.version,
        toVersion: currentApp.version,
      });
    }
  }

  const addedApps = parsedCurrent.applications.filter(
    app =>
      !parsedOriginal.applications.some(original => original.name === app.name)
  );
  addedApps.forEach(app => {
    info(`${app.name} has been added`);
    changes.push({
      type: ChangeType.ADDED,
      application: app.name,
      toVersion: app.version,
    });
  });

  if (changes.length === 0) {
    info('No changes to report');
    await deleteCommentWithFooterIfExists(footer);
    return;
  }

  // Figure out changes
  const changesWithCommits = new Array<
    typeof changes[0] & {
      repo: string;
      fromRef: string;
      toRef: string;
      compare_url?: string;
      commits?: Array<types.components['schemas']['commit']>;
    }
  >();

  for (const change of changes) {
    const repo = `GreenlightMe/${await applicationNameToRepo(
      change.application
    )}`;
    const fromRef = await refFromVersion(change.fromVersion!);
    const toRef = await refFromVersion(change.toVersion!);

    const changeWithCommits = {
      ...change,
      repo,
      fromRef,
      toRef,
    } as typeof changesWithCommits[0];

    if (change.type === ChangeType.MODIFIED) {
      try {
        info(
          `Getting commits for ${repo} between ${change.fromVersion} to ${change.toVersion}`
        );
        const {commits, html_url} = await compareCommits(repo, fromRef, toRef);
        changeWithCommits.compare_url = html_url;
        changeWithCommits.commits = commits;
      } catch (e) {
        warning(`${change.application} had an error getting diff: ${e}`);
      }
    }

    changesWithCommits.push(changeWithCommits);
  }

  // Compute required approvers

  info('Listing PR approvers');
  const allAuthors = changesWithCommits.reduce((a, c) => {
    if (c.commits) {
      c.commits.forEach(commit => {
        if (commit.author) {
          a.add(commit.author.login);
        }
      });
    }
    return a;
  }, new Set<string>());

  const [currentPR, approvedAuthors] = await Promise.all([
    getCurrentPR(),
    // filter only approved reviews from users
    getReviews().then(
      reviews =>
        new Set(
          reviews
            .filter(
              r =>
                r.state === 'APPROVED' &&
                r.user !== null &&
                allAuthors.has(r.user.login)
            )
            .map(r => r.user!.login)
        )
    ),
  ]);
  if (currentPR.user) {
    // PR author implicitly approves their changes
    approvedAuthors.add(currentPR.user.login);
  }
  for (const author of allAuthors) {
    if (author.endsWith('[bot]')) {
      approvedAuthors.add(author); // Auto-approve bots
    }
  }
  const pendingAuthors =
    currentPR.requested_reviewers?.reduce((a, c) => {
      if (c !== null && allAuthors.has(c.login)) {
        a.add(c.login);
      }
      return a;
    }, new Set<string>()) ?? new Set<string>();
  const authorsToAdd = Array.from(allAuthors).filter(
    a => !pendingAuthors.has(a) && !approvedAuthors.has(a)
  );

  const validAuthorsToAdd = (
    await Promise.all(
      authorsToAdd.map(async author => {
        if (!(await isCollaborator(author))) {
          info(`${author} is not an engineer Greenlight`);
          approvedAuthors.add(author);
          return null;
        } else {
          return author;
        }
      })
    )
  ).filter(a => a !== null) as Array<string>;

  info('Authors:');
  info('\tApproved: ' + Array.from(approvedAuthors));
  info('\tPending:  ' + Array.from(pendingAuthors));
  info('\tNew:      ' + Array.from(validAuthorsToAdd));

  if (validAuthorsToAdd.length) {
    await requestReviews(validAuthorsToAdd);
    validAuthorsToAdd.forEach(a => pendingAuthors.add(a));
  }

  // Build markdown
  let markdown = `### Changes made to \`${environmentFile}\` in this PR:\n\n`;

  for (const change of changesWithCommits) {
    if (change.type === ChangeType.ADDED) {
      markdown += `#### :new: ${change.application} has been added\n`;
    } else if (change.type === ChangeType.DELETED) {
      markdown += `#### :no_entry: ${change.application} has been removed\n`;
    } else if (change.type === ChangeType.MODIFIED) {
      const otherEnvironmentVersionsMarkdown = `> ${allEnvironmentFiles
        .filter(([, f]) => f.project !== environmentFile.project)
        .map(([{domain, project}, f]) => {
          const version = f.applications.find(
            a => a.name === change.application
          )?.version;
          if (!version) return null;
          else return `\`${version}\` is deployed to \`${domain}/${project}\``;
        })
        .filter(l => l !== null)
        .join(', ')}\n`;

      if (change.compare_url && change.commits) {
        markdown += `#### :checkered_flag: ${change.application} has been updated from \`${change.fromVersion}\` to \`${change.toVersion}\` ([${change.commits.length} changes](${change.compare_url}))\n`;
        markdown += otherEnvironmentVersionsMarkdown;

        const commitsByAuthor = getCommitsByAuthor(change.commits);

        for (const [author, commits] of commitsByAuthor.entries()) {
          const authorStatus = (() => {
            if (pendingAuthors.has(author)) return ':yellow_circle: ';
            if (approvedAuthors.has(author)) return ':white_check_mark: ';
            return '';
          })();
          markdown += `* ${authorStatus} @${author} (${commits.length} changes):\n`;
          for (const commit of commits) {
            let message = commit.commit.message.split('\n', 1)[0];

            // replace "(#123)" pr tags with links to the pr
            message = message.replace(
              /\(#(\d+)\)/g,
              `([#$1](https://github.com/${change.repo}/pull/$1))`
            );

            const commitLink = `[[${commit.sha.substring(0, 7)}](${
              commit.html_url
            })]`;
            markdown += `  * ${commitLink} ${message}\n`;
          }
        }
      } else {
        markdown += `#### :warning: ${change.application} has been updated from \`${change.fromVersion}\` to \`${change.toVersion}\` (unknown changes) :warning:\n`;
        const [from, to] = await Promise.allSettled([
          getCommit(change.repo, change.fromRef),
          getCommit(change.repo, change.toRef),
        ]);

        if (from.status === 'rejected') {
          warning(`${change.fromRef} didn't exist: ${from.reason}`);
          markdown += `* \`${change.fromVersion}\` (${change.fromRef}) does not exist in ${change.repo}`;
        }

        if (to.status === 'rejected') {
          warning(`${change.toRef} didn't exist: ${to.reason}`);
          markdown += `* \`${change.toVersion}\` (${change.toRef}) does not exist in ${change.repo}`;
        }
      }
    }
    markdown += '\n';
  }

  markdown = defaultSanitizer(markdown);
  await createOrUpdateCommentWithFooter(markdown, footer);
}

main().catch((err: Error) => {
  setFailed(err);
});
