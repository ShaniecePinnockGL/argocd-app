import {info, setFailed} from '@actions/core';
import {context} from '@actions/github';
import {getReviews} from '../lib/github';
import {
  PullRequestEvent,
  PullRequestReviewEvent,
} from '@octokit/webhooks-types';
import {getChangedFiles} from '../lib/git';
import {Domain, ENVIRONMENT_FILES_REGEX} from '../lib/common';

// Borrowed from https://github.com/snow-actions/unanimously-approved
async function main(): Promise<void> {
  try {
    const {pull_request: pr} =
      context.eventName === 'pull_request'
        ? (context.payload as PullRequestEvent)
        : (context.payload as PullRequestReviewEvent);

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
    const shouldPreventMerge = changedEnvironmentFiles.some(
      f => f.domain === Domain.Greenlight && f.project === 'prod'
    );

    info(`PR#${pr.number}`);
    info(`requested reviewers: ${pr.requested_reviewers.length}`);

    if (pr.requested_reviewers.length > 0 && shouldPreventMerge) {
      throw new Error('Some reviewers are still in review.');
    }

    const reviews = await getReviews();

    info(`reviews: ${reviews.length}`);

    if (reviews.length === 0 && shouldPreventMerge) {
      throw new Error('There are no reviewers.');
    }

    const latestReviews = reviews
      .reverse()
      .filter(review => review.user?.id !== pr.user.id)
      .filter(review => review.state.toLowerCase() !== 'commented')
      .filter((review, index, array) => {
        // remove duplicates
        return array.findIndex(x => review.user?.id === x.user?.id) === index;
      });

    for (const review of latestReviews) {
      if (review.user) {
        info(`\t${review.user.login} is ${review.state.toLowerCase()}.`);
      }
    }

    if (
      !latestReviews.every(
        review => review.state.toLowerCase() === 'approved'
      ) &&
      shouldPreventMerge
    ) {
      throw new Error('Some reviewers do not approve.');
    }

    info('All reviewers approve.');
  } catch (error) {
    setFailed(error.message);
  }
}

main();
