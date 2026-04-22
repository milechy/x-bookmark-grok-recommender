import type { VercelRequest, VercelResponse } from '@vercel/node';
import { WebClient } from '@slack/web-api';
import { handleOAuthCallback } from '../../src/oauth.js';

const slackClient = new WebClient(process.env.SLACK_BOT_TOKEN);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method not allowed');
  }

  const { code, state, error } = req.query as { 
    code?: string; 
    state?: string; 
    error?: string;
  };

  if (error) {
    console.error('OAuth error from X:', error);
    return res.redirect('/?error=' + encodeURIComponent(error as string));
  }

  if (!code || !state) {
    return res.status(400).send('Missing code or state parameter');
  }

  try {
    const result = await handleOAuthCallback(code, state);

    if (result.success && result.slackUserId) {
      // Send success DM
      await slackClient.chat.postMessage({
        channel: result.slackUserId,
        text: '🎉 X認証が完了しました！',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '✅ *Xログイン完了！*\n\nX Bookmark Grok Recommenderの準備が整いました。\n\n`/bookmark AIについて` のように要件を指定して、ブックマークからおすすめをGrokに分析させましょう！\n\n`/bookmark-sync` で最新のブックマークを同期できます。',
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
                text: '💡 ブックマークは自動でキャッシュされ、Grokがセマンティック検索で上位推薦します。',
              },
            ],
          },
        ],
      });

      // Success page
      res.send(`
        <html>
          <head>
            <meta charset="UTF-8">
            <title>X認証完了 - X Bookmark Grok Recommender</title>
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                     text-align: center; padding: 60px 20px; background: linear-gradient(135deg, #1a1a2e, #16213e); color: white; }
              .success { font-size: 48px; margin-bottom: 20px; }
              .container { max-width: 500px; margin: 0 auto; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="success">🎉</div>
              <h1>X認証が完了しました</h1>
              <p style="font-size: 18px; line-height: 1.6; margin: 20px 0;">
                Slackに戻って <strong>/bookmark</strong> コマンドをお試しください。<br>
                DMで成功通知が届いています。
              </p>
              <p style="margin-top: 40px; opacity: 0.7;">
                X Bookmark Grok Recommender<br>
                Powered by Grok • Vercel • Bolt
              </p>
            </div>
          </body>
        </html>
      `);
    } else {
      res.status(400).send(`認証に失敗しました: ${result.error || '不明なエラー'}`);
    }
  } catch (err: any) {
    console.error('Callback handler error:', err);
    res.status(500).send('サーバーエラーが発生しました。もう一度お試しください。');
  }
}
