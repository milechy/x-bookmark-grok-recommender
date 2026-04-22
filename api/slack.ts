import { App } from '@slack/bolt';
import { registerCommands } from '../src/commands.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let appPromise: Promise<App> | null = null;

async function getOrCreateApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const app = new App({
        token: process.env.SLACK_BOT_TOKEN!,
        signingSecret: process.env.SLACK_SIGNING_SECRET!,
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
    const app = await getOrCreateApp();
    
    // Use the built-in request handler from Bolt for Vercel
    // This bypasses direct receiver access which has private properties in v4
    if (req.url?.includes('/slack')) {
      // For events, commands, actions
      const body = req.body || req;
      await app.processEvent(body as any);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
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
