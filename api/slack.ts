import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';

// Verify Slack request signature
function verifySlackSignature(req: VercelRequest, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const signature = req.headers['x-slack-signature'] as string;
  if (!timestamp || !signature) return false;

  // Reject old requests (replay attacks)
  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const mySignature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

// Parse URL-encoded body from Slack
function parseBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

async function readRawBody(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') {
    // Vercel already parsed it - reconstruct urlencoded
    return new URLSearchParams(req.body as any).toString();
  }
  return '';
}

// Send delayed response via response_url
async function sendDelayedResponse(responseUrl: string, payload: any): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[response_url] Failed:', err);
  }
}

// Handle commands async (after immediate 200 ack)
async function processCommand(params: Record<string, string>): Promise<void> {
  const { command, text, user_id, response_url } = params;
  console.log(`[Slack] Processing ${command} for user ${user_id}`);

  try {
    const { storage } = await import('../src/storage.js');
    const { createAuthUrl } = await import('../src/oauth.js');

    const tokens = await storage.getUserTokens(user_id);

    if (!tokens) {
      const authUrl = await createAuthUrl(user_id);
      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*X Bookmark Grok Recommender* 🚀\n\n初回利用時はXログインが必要です。下のボタンからXにログインしてください。',
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Xでログイン 🔐', emoji: true },
                style: 'primary',
                url: authUrl,
              },
            ],
          },
        ],
      });
      return;
    }

    if (command === '/bookmark-sync') {
      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        text: '🔄 ブックマークを同期中...（最大800件、数秒かかります）',
      });

      const { XService } = await import('../src/services/x.js');
      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();
      const bookmarks = await xService.getAllBookmarks(true, user_id);

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: `✅ 同期完了！ *${bookmarks.length}件* のブックマークをキャッシュしました。\n\n次に \`/bookmark <要件>\` でGrok推薦をお試しください。`,
      });
      return;
    }

    if (command === '/bookmark') {
      const query = (text || '').trim() || 'おすすめのブックマーク';

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        text: `🔍 「${query}」で分析中... Grokがブックマークからおすすめを選定しています⏳`,
      });

      const { XService } = await import('../src/services/x.js');
      const { GrokService } = await import('../src/services/grok.js');
      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();
      const bookmarks = await xService.getAllBookmarks(false, user_id);

      if (bookmarks.length === 0) {
        await sendDelayedResponse(response_url, {
          response_type: 'ephemeral',
          replace_original: true,
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
        });
        return;
      }

      const grok = new GrokService();
      const recommendations = await grok.rankBookmarks(query, bookmarks);

      const blocks: any[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📚 Xブックマーク Grok推薦', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*クエリ:* \`${query}\`　*分析:* ${bookmarks.length}件 → 上位${recommendations.length}件`,
          },
        },
        { type: 'divider' },
      ];

      recommendations.forEach((rec: any, i: number) => {
        const b = rec.bookmark;
        const color = rec.score >= 85 ? '🟢' : rec.score >= 70 ? '🟡' : '🔴';
        const excerpt = b.text.length > 180 ? b.text.substring(0, 177) + '...' : b.text;

        blocks.push(
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*${color} ${rec.score}%* — ${b.authorName} (@${b.authorUsername})\n` +
                `${new Date(b.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}`,
            },
          },
          { type: 'section', text: { type: 'mrkdwn', text: `> ${excerpt}` } }
        );

        if (b.media && b.media.length > 0) {
          const m = b.media[0];
          if (m.previewUrl || m.url) {
            blocks.push({
              type: 'image',
              image_url: m.previewUrl || m.url,
              alt_text: 'メディア',
            });
          }
        }

        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `📊 関連度 ${rec.score}% ｜ ${rec.reason}` }],
        });
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Xで開く 🔗', emoji: true },
              url: b.url,
              style: 'primary',
            },
          ],
        });
        if (i < recommendations.length - 1) blocks.push({ type: 'divider' });
      });

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        blocks,
        text: 'Xブックマーク推薦結果',
      });
    }
  } catch (error: any) {
    console.error('[processCommand] Error:', error);
    await sendDelayedResponse(params.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: `❌ エラーが発生しました: ${error.message || error}\n\nX認証が切れている場合は再度 \`/bookmark\` を実行してください。`,
    });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<any> {
  console.log(`[Slack] ${req.method} ${req.url}`);

  // Health check for browser / debug
  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'ok',
      service: 'X Bookmark Grok Recommender Slack Endpoint',
      env_check: {
        SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN,
        SLACK_SIGNING_SECRET: !!process.env.SLACK_SIGNING_SECRET,
        GROK_API_KEY: !!process.env.GROK_API_KEY,
        X_CLIENT_ID: !!process.env.X_CLIENT_ID,
        KV_REST_API_URL: !!process.env.KV_REST_API_URL || !!process.env.VERCEL_KV_REST_API_URL,
      },
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const rawBody = await readRawBody(req);

    if (!verifySlackSignature(req, rawBody)) {
      console.error('[Slack] Invalid signature');
      return res.status(401).send('Invalid signature');
    }

    const params = parseBody(rawBody);
    console.log(`[Slack] command=${params.command} user=${params.user_id}`);

    // Queue async processing to continue after response is sent
    // waitUntil keeps the function alive until the promise resolves
    waitUntil(
      processCommand(params).catch((err) => {
        console.error('[Slack] Background processing error:', err);
      })
    );

    // Immediately ack (must be < 3s)
    return res.status(200).send('');
  } catch (error: any) {
    console.error('[Slack handler] Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || 'Internal error' });
    }
  }
}
