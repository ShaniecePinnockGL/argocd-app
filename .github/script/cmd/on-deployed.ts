import {IArgoApp, getEnvironment} from '../lib/argo';
import {
  TDeploymentState,
  createDeployment,
  createDeploymentStatus,
} from '../lib/github';
import {
  applicationNameToRepo,
  readLocalFile,
  refFromVersion,
} from '../lib/common';
import {parse} from 'yaml';
import {components} from '@octokit/openapi-types';
import {context} from '@actions/github';
import {postMessage} from '../lib/slack';
import {endGroup, info, setFailed, startGroup} from '@actions/core';

interface ISlackChannel {
  domains: {
    [name: string]: {
      default: Array<string>;
      projects: {
        [environment: string]: Array<string>;
      };
    };
  };
}

async function finalizeDeployment(a: IArgoApp) {
  const name = applicationNameToRepo(a.metadata.labels.application);
  const {domain, project, region} = getEnvironment(a);
  const d = (await createDeployment(
    name,
    refFromVersion(a.status.sync.revision),
    `${domain}-${project}-${region}`
  )) as components['schemas']['deployment'];
  let state: TDeploymentState;
  switch (a.status.operationState.phase) {
    case 'Succeeded':
      state = 'success';
      break;
    case 'Failed':
    default:
      state = 'failure';
      break;
  }
  await createDeploymentStatus(
    name,
    d.id,
    state,
    `https://argocd.glops.io/applications/${a.metadata.name}`
  );
}

async function sendSlackMessage(a: IArgoApp) {
  const slackChannels = parse(
    await readLocalFile('.github/slack-channels.yaml')
  ) as ISlackChannel;

  const {domain, project, region} = getEnvironment(a);
  const channels =
    slackChannels.domains[domain]?.projects[project] ??
    slackChannels.domains[domain]?.default ??
    [];

  let message, color: string;
  switch (a.status.operationState.phase) {
    case 'Succeeded':
      message = `Deployed *${a.metadata.labels.application}@${a.status.sync.revision}* to *${domain}-${project}-${region}*`;
      color = 'good';
      break;
    case 'Failed':
    default:
      message = `Failed to deploy *${a.metadata.labels.application}@${a.status.sync.revision}* to *${domain}-${project}-${region}*`;
      color = 'bad';
      break;
  }

  const argoCdLink = `https://argocd.glops.io/applications/${a.metadata.name}`;
  const gitHubLink = `https://github.com/GreenlightMe/${applicationNameToRepo(
    a.metadata.labels.application
  )}/deployments/activity_log?environment=${domain}-${project}-${region}`;

  const promises = [];
  for (const channel of channels) {
    const epoch = Math.round(Date.now() / 1000);
    promises.push(
      postMessage(channel, message, [
        {
          blocks: [
            {
              type: 'section',
              text: {type: 'mrkdwn', text: message},
            },
            {type: 'divider'},
            {
              type: 'context',
              elements: [
                {
                  type: 'mrkdwn',
                  text: `<!date^${epoch}^{date_num} {time_secs}|${Date.now()}> <${argoCdLink}|:argo: Argo CD> <${gitHubLink}|:octocat: GitHub>`,
                },
              ],
            },
          ],
          color,
        },
      ])
    );
  }

  const responses = await Promise.allSettled(promises);
  startGroup('Slack messages');
  info(JSON.stringify(responses));
  endGroup();
}

async function entrypoint() {
  try {
    const a: IArgoApp = context.payload.client_payload;
    startGroup('Argo CD context');
    info(JSON.stringify(a, null, 2));
    endGroup();
    await finalizeDeployment(a);
    await sendSlackMessage(a);
  } catch (error: unknown) {
    setFailed(error as Error);
  }
}

void entrypoint();
