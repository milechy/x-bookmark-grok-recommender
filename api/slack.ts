import { App, ExpressReceiver } from '@slack/bolt';
import { registerCommands } from '../src/commands.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let receiver: ExpressReceiver | null = null;

function getReceiver(): ExpressReceiver {
  if (receiver) return receiver;

  receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    // processBeforeResponse: false (default) allows ack() first, then continue heavy work
    // This is critical for Vercel serverless - Slack requires HTTP 200 within 3s
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

  console.log('🚀 Slack Bolt App initialized for Vercel (ExpressReceiver)');
  return receiver;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  return new Promise<void>((resolve, reject) => {
    try {
      const r = getReceiver();
      // ExpressReceiver.app is the underlying Express app - pass req/res directly
      r.app(req as any, res as any, (err: any) => {
        if (err) {
          console.error('Express handler error:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal Server Error' });
          }
          reject(err);
        } else {
          resolve();
        }
      });
    } catch (error: any) {
      console.error('Handler setup error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal Server Error' });
      }
      reject(error);
    }
  });
}
