import { App, HTTPReceiver } from '@slack/bolt';
import { registerCommands } from '../src/commands.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let appPromise: Promise<App> | null = null;

function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const receiver = new HTTPReceiver({
        signingSecret: process.env.SLACK_SIGNING_SECRET!,
        endpoints: {
          events: '/api/slack',
          commands: '/api/slack',
          actions: '/api/slack',
        },
      });

      const app = new App({
        token: process.env.SLACK_BOT_TOKEN!,
        receiver,
        socketMode: false,
      });

      registerCommands(app);

      app.error(async (error) => {
        console.error('❌ Slack App Error:', error);
      });

      console.log('🚀 Slack Bolt App initialized for Vercel');
      return app;
    })();
  }
  return appPromise;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const app = await getApp();
    const receiver = app.receiver as HTTPReceiver;
    await receiver.requestHandler(req as any, res as any);
  } catch (error: any) {
    console.error('Vercel handler error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Slackボットの処理中にエラーが発生しました。',
      });
    }
  }
}
