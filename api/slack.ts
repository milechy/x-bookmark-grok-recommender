/**
 * Slack エントリ（Node）。
 * - 即 ACK（ここで 200 を返す）
 * - 重い処理は waitUntil で同プロセス継続（関数ハンドルを跨がないので
 *   Vercel Deployment Protection 等に影響を受けない）
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { waitUntil } from '@vercel/functions';
import { processSlackCommand } from '../src/slack-process-command.js';

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
  const mySignature = 'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
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
    // 既にパース済み → 元のバイト列は失われている。署名検証は失敗する可能性があるが最終防御として復元
    return new URLSearchParams(req.body as Record<string, string>).toString();
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

  try {
    const rawBody = await readRawBodyStream(req);
    if (!rawBody) {
      console.error('[Slack] Empty body');
      res.status(400).send('Bad request');
      return;
    }

    if (!verifySlackSignature(req, rawBody)) {
      console.error('[Slack] Invalid signature');
      res.status(401).send('Invalid signature');
      return;
    }

    const params = parseBody(rawBody);
    console.log(`[Slack] command=${params.command} user=${params.user_id}`);

    // 重い処理を同プロセスの waitUntil で実行（HTTP 200 は先に返す）
    waitUntil(
      processSlackCommand(params).catch((err) =>
        console.error('[Slack] background error:', err)
      )
    );

    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': '0',
    });
    res.end();
  } catch (error) {
    console.error('[Slack handler]', error);
    if (!res.headersSent) {
      res.status(500).send('Internal error');
    }
  }
}
