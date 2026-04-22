/**
 * Slack エントリ（Node）。
 * 原則：
 *  - 署名検証と ACK(200) *だけ* を即返す
 *  - 重い依存（@slack/web-api, twitter-api-v2, openai, @vercel/kv 等）は
 *    **一切 top-level で import しない**（コールドスタートで3秒を超えないため）
 *  - 重処理は waitUntil 内で **動的 import** だけ使う
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';

export const config = {
  api: {
    bodyParser: false,
  },
};

function verifySlackSignature(req: VercelRequest, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;

  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const signature = req.headers['x-slack-signature'] as string | undefined;
  if (!timestamp || !signature) return false;

  const fiveMinAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinAgo) return false;

  const baseString = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(mySignature, 'utf8'), Buffer.from(signature, 'utf8'));
  } catch {
    return false;
  }
}

function parseBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

async function readRawBodyStream(req: VercelRequest): Promise<string> {
  if (typeof req.body === 'string' && req.body.length > 0) return req.body;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) return req.body.toString('utf8');
  if (
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body) &&
    !Buffer.isBuffer(req.body) &&
    Object.keys(req.body as object).length > 0
  ) {
    return new URLSearchParams(req.body as Record<string, string>).toString();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const t0 = Date.now();
  console.log(`[Slack] ${req.method} ${req.url}`);

  if (req.method === 'GET') {
    res.status(200).json({
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
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // Slack リトライは即 200（重複実行を避ける）
  const retryNum = req.headers['x-slack-retry-num'];
  const retryReason = req.headers['x-slack-retry-reason'];
  if (retryNum) {
    console.log(`[Slack] retry ignored: num=${retryNum} reason=${retryReason}`);
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
    return;
  }

  let params: Record<string, string> | undefined;
  try {
    const rawBody = await readRawBodyStream(req);
    if (!rawBody) {
      console.error('[Slack] Empty body');
      res.status(400).send('Bad request');
      return;
    }
    console.log(`[Slack] rawBody ready (${rawBody.length} bytes, +${Date.now() - t0}ms)`);

    if (!verifySlackSignature(req, rawBody)) {
      console.error('[Slack] Invalid signature');
      res.status(401).send('Invalid signature');
      return;
    }

    params = parseBody(rawBody);
    console.log(`[Slack] verified (+${Date.now() - t0}ms) command=${params.command} user=${params.user_id}`);
  } catch (error) {
    console.error('[Slack handler]', error);
    if (!res.headersSent) {
      res.status(500).send('Internal error');
    }
    return;
  }

  // 1) 先に waitUntil を登録（res.end() より前！）
  //    これをしないと Vercel Node は res.end() 後に関数を終了し、バックグラウンドが走らない。
  const capturedParams = params!;
  waitUntil(
    (async () => {
      const b0 = Date.now();
      try {
        console.log('[Slack] bg: dynamic import start');
        const mod = await import('../src/slack-process-command.js');
        console.log(`[Slack] bg: dynamic import done (+${Date.now() - b0}ms)`);
        await mod.processSlackCommand(capturedParams);
        console.log(`[Slack] bg: done (+${Date.now() - b0}ms)`);
      } catch (err) {
        console.error('[Slack] bg error:', err);
      }
    })()
  );

  // 2) ACK 200 を返す
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': '0',
  });
  res.end();
  console.log(`[Slack] 200 ACK sent (+${Date.now() - t0}ms)`);
}
