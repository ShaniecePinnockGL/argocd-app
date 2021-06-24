import {IArgoApp, getCurrentPreviousHistoryRevision} from '../lib/argo';
import {
  applicationNameToRepo,
  readLocalFile,
  refFromVersion,
} from '../lib/common';
import {createDeployment, createDeploymentStatus} from '../lib/github';
import {parse} from 'yaml';
import {components} from '@octokit/openapi-types';
import {context} from '@actions/github';
import {postMessage} from '../lib/slack';
import {setFailed} from '@actions/core';

interface ISlackChannel {
  domain: {
    [name: string]: {
      channels: Array<string>;
      prod: {channels: Array<string>};
    };
  };
}

async function finalizeDeployment(p: IArgoApp) {
  const name = applicationNameToRepo(p.metadata.labels.application);
  const d = (await createDeployment(
    name,
    refFromVersion(p.status.sync.revision),
    p.metadata.labels.cluster
  )) as components['schemas']['deployment'];
  switch (p.status.operationState.phase) {
    case 'Succeeded':
      await createDeploymentStatus(name, d.id, 'success');
      break;
    case 'Failed':
    default:
      await createDeploymentStatus(name, d.id, 'failure');
      break;
  }
}

async function sendSlackMessage(p: IArgoApp) {
  const slackChannels = parse(
    await readLocalFile('.github/slack-channels.yaml')
  ) as ISlackChannel;

  let channels: Array<string>;
  if (p.metadata.labels.cluster.includes('krona')) {
    if (p.metadata.labels.cluster.includes('prod'))
      channels = slackChannels.domain['krona'].prod.channels;
    channels = slackChannels.domain['krona'].channels;
  } else if (p.metadata.labels.cluster.includes('gl')) {
    if (p.metadata.labels.cluster.includes('prod'))
      channels = slackChannels.domain['gl'].prod.channels;
    channels = slackChannels.domain['gl'].channels;
  } else {
    channels = slackChannels.domain['operations'].channels;
  }

  let message: string;
  switch (p.status.operationState.phase) {
    case 'Succeeded':
      message = `:white_check_mark: *${p.metadata.labels.application}@${p.status.sync.revision}* was deployed to *${p.metadata.labels.cluster}*`;
      break;
    case 'Failed':
    default:
      message = `:x: *${p.metadata.labels.application}@${p.status.sync.revision}* failed to deploy to *${p.metadata.labels.cluster}*`;
      break;
  }

  const {current: rawCurrent, previous: rawPrevious} =
    getCurrentPreviousHistoryRevision(p);
  const [previous, current] = [
    refFromVersion(rawPrevious),
    refFromVersion(rawCurrent),
  ];
  const argoCdLink = `https://argocd.glops.io/applications/${p.metadata.name}`;
  let gitHubLink: string;
  if (previous) {
    gitHubLink = `https://github.com/GreenlightMe/${p.metadata.labels.application}/compare/${previous}...${current}`;
  } else {
    gitHubLink = `https://github.com/GreenlightMe/${p.metadata.labels.application}`;
  }

  const promises = [];
  for (const channel of channels) {
    promises.push(
      postMessage(channel, message, [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: message,
          },
        },
        {
          type: 'divider',
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `<!date^${Math.round(
                Date.now() / 1000
              )}^{date_num} {time_secs}|${Date.now()}> <${argoCdLink}|:argo: Argo CD> <${gitHubLink}|:octocat: GitHub>`,
            },
          ],
        },
      ])
    );
  }

  await Promise.allSettled(promises);
}

async function entrypoint() {
  try {
    const p: IArgoApp = context.payload.client_payload;
    await finalizeDeployment(p);
    await sendSlackMessage(p);
  } catch (error: unknown) {
    setFailed(error as Error);
  }
}

void entrypoint();
