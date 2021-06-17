import got from 'got';

const slackToken = process.env.SLACK_TOKEN;

export async function postMessage(channel: string, markdown: string) {
  const response = await got<{ok: true}>(
    'https://slack.com/api/chat.postMessage',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${slackToken}`,
      },
      responseType: 'json',
      json: {
        channel,
        text: markdown,
      },
    }
  );
  return response.body;
}
