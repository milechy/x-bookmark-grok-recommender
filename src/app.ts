import { App, ExpressReceiver } from '@slack/bolt';
import { registerCommands } from './commands.js';
import dotenv from 'dotenv';

dotenv.config();

export function createSlackApp(): App {
  // This is used for local development only now.
  // Production uses a dedicated handler in api/slack.ts
  const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    endpoints: {
      events: '/slack/events',
      commands: '/slack/commands',
      actions: '/slack/actions',
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

  console.log('🚀 Slack Bolt App initialized with Japanese support');
  return app;
}

// For local development with Express
export async function startLocalServer() {
  const expressReceiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
    endpoints: {
      events: '/slack/events',
      commands: '/slack/commands',
      actions: '/slack/actions',
    },
  });

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: expressReceiver,
  });

  registerCommands(app);

  const expressApp = expressReceiver.app;
  const port = process.env.PORT || 3000;

  // Health check
  expressApp.get('/health', (_req, res) => {
    res.json({ status: 'healthy', service: 'X Bookmark Grok Recommender' });
  });

  expressApp.get('/', (_req, res) => {
    res.send(`
      <h1>X Bookmark Grok Recommender Slack Bot</h1>
      <p>ボットは正常に起動しています。</p>
      <p><a href="/slack/events">Slack Events Endpoint</a></p>
      <p>環境: ${process.env.NODE_ENV || 'development'}</p>
      <hr>
      <h2>セットアップ手順</h2>
      <ol>
        <li>SlackアプリでSlashコマンドを登録</li>
        <li>/bookmark と /bookmark-sync を追加</li>
        <li>OAuth & Permissionsで必要なスコープを設定</li>
      </ol>
      <p>詳細は README.md を参照してください。</p>
    `);
  });

  await app.start(port);
  console.log(`✅ Bolt app is running on port ${port}!`);
  console.log('📍 Local endpoints:');
  console.log(`   - Events: http://localhost:${port}/slack/events`);
  console.log('   - Use ngrok for public URL in development.');
  
  return app;
}
