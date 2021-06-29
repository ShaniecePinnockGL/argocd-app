import {Block, KnownBlock, WebClient, MessageAttachment} from '@slack/web-api';
import {setSecret} from '@actions/core';

const token = process.env.SLACK_TOKEN ?? '';
setSecret(token);

const web = new WebClient(token);

export async function postMessage(
  channel: string,
  text: string,
  blocks?: (KnownBlock | Block)[],
  attachments?: MessageAttachment[]
) {
  return web.chat.postMessage({
    channel,
    text,
    blocks,
    attachments,
  });
}
