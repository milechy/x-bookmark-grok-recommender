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
import { DebugLogger, newReqId } from '../src/debug-log.js';

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
  const reqId = newReqId('slack');
  const log = new DebugLogger(reqId);
  void log.info(`${req.method} ${req.url}`, undefined, 'entry');

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

  const retryNum = req.headers['x-slack-retry-num'];
  const retryReason = req.headers['x-slack-retry-reason'];
  if (retryNum) {
    void log.warn('Slack retry ignored', { retryNum, retryReason }, 'retry');
    res.writeHead(200, { 'Content-Length': '0' });
    res.end();
    return;
  }

  let params: Record<string, string> | undefined;
  try {
    const rawBody = await readRawBodyStream(req);
    if (!rawBody) {
      void log.error('Empty body', undefined, 'body');
      res.status(400).send('Bad request');
      return;
    }
    void log.info(`rawBody ready (${rawBody.length} bytes)`, undefined, 'body');

    if (!verifySlackSignature(req, rawBody)) {
      void log.error('Invalid signature', undefined, 'sig');
      res.status(401).send('Invalid signature');
      return;
    }

    params = parseBody(rawBody);
    void log.info(
      'verified',
      {
        command: params.command,
        user_id: params.user_id,
        text_len: (params.text || '').length,
        isPayload: !!params.payload,
      },
      'sig'
    );
  } catch (error) {
    void log.error('handler exception', error, 'entry');
    if (!res.headersSent) {
      res.status(500).send('Internal error');
    }
    return;
  }

  const capturedParams = params!;
  const isInteractivity = !!capturedParams.payload;

  // 1) 先に waitUntil を登録（res.end() より前！）
  waitUntil(
    (async () => {
      try {
        await log.info('bg: dynamic import start', { isInteractivity }, 'bg');
        const mod = await import('../src/slack-process-command.js');
        await log.info('bg: dynamic import done', undefined, 'bg');
        if (isInteractivity) {
          await mod.processSlackInteractivity(capturedParams.payload, reqId);
        } else {
          await mod.processSlackCommand(capturedParams, reqId);
        }
        await log.info('bg: done', undefined, 'bg');
      } catch (err) {
        await log.error('bg error', err, 'bg');
      }
    })()
  );

  // 2) ACK 200 を返す
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': '0',
  });
  res.end();
  void log.info(`ACK 200 sent (+${Date.now() - t0}ms)`, undefined, 'ack');
}
