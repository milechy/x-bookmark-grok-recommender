import type { VercelRequest, VercelResponse } from '@vercel/node';

let initError: string | null = null;
let receiverApp: any = null;

async function initialize() {
  if (receiverApp) return receiverApp;

  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    initError = `Missing env vars: ${missing.join(', ')}`;
    console.error(initError);
    throw new Error(initError);
  }

  const { App, ExpressReceiver } = await import('@slack/bolt');
  const { registerCommands } = await import('../src/commands.js');

  const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    processBeforeResponse: true,
  });

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN!,
    receiver,
    socketMode: false,
  });

  registerCommands(app);

  app.error(async (error) => {
    console.error('Slack App Error:', error);
  });

  receiverApp = receiver.app;
  console.log('🚀 Slack Bolt initialized');
  return receiverApp;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log(`[Slack] ${req.method} ${req.url}`);

  // GET for health-check
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'X Bookmark Grok Recommender Slack Endpoint',
      env_check: {
        SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN,
        SLACK_SIGNING_SECRET: !!process.env.SLACK_SIGNING_SECRET,
        GROK_API_KEY: !!process.env.GROK_API_KEY,
        X_CLIENT_ID: !!process.env.X_CLIENT_ID,
        VERCEL_KV_REST_API_URL: !!process.env.VERCEL_KV_REST_API_URL,
      },
      initError,
    });
  }

  try {
    const app = await initialize();
    return new Promise<void>((resolve, reject) => {
      app(req as any, res as any, (err: any) => {
        if (err) {
          console.error('Handler error:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: String(err.message || err) });
          }
          reject(err);
        } else {
          resolve();
        }
      });
    });
  } catch (error: any) {
    console.error('Init error:', error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Initialization failed',
        detail: error.message,
      });
    }
  }
}
