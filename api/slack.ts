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

type SigCheckResult =
  | { ok: true }
  | { ok: false; reason: string; detail?: Record<string, unknown> };

function verifySlackSignature(req: VercelRequest, rawBody: string): SigCheckResult {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return { ok: false, reason: 'SLACK_SIGNING_SECRET unset' };

  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const signature = req.headers['x-slack-signature'] as string | undefined;
  if (!timestamp) return { ok: false, reason: 'missing x-slack-request-timestamp' };
  if (!signature) return { ok: false, reason: 'missing x-slack-signature' };

  const now = Math.floor(Date.now() / 1000);
  if (parseInt(timestamp, 10) < now - 60 * 5) {
    return { ok: false, reason: 'timestamp too old', detail: { timestamp, now } };
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    'v0=' + crypto.createHmac('sha256', signingSecret).update(baseString).digest('hex');
  try {
    const equal = crypto.timingSafeEqual(
      Buffer.from(mySignature, 'utf8'),
      Buffer.from(signature, 'utf8')
    );
    if (equal) return { ok: true };
    return {
      ok: false,
      reason: 'signature mismatch',
      detail: {
        rawBodyLen: rawBody.length,
        mySignaturePrefix: mySignature.slice(0, 20),
        theirSignaturePrefix: signature.slice(0, 20),
      },
    };
  } catch (e) {
    return { ok: false, reason: 'compare error', detail: { err: String(e) } };
  }
}

function parseBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

/**
 * Slack 署名検証には *バイト列同一* の raw body が必要。
 * bodyParser: false の下で、まずストリームを最優先で読む。
 * 0 バイトしか得られなかった時のみ、pre-parsed body の再構築にフォールバック。
 */
async function readRawBody(
  req: VercelRequest
): Promise<{ raw: string; source: 'stream' | 'string' | 'buffer' | 'reconstructed' | 'empty' }> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length > 0) {
      const buf = Buffer.concat(chunks);
      if (buf.length > 0) return { raw: buf.toString('utf8'), source: 'stream' };
    }
  } catch {
    // fallthrough
  }

  if (typeof req.body === 'string' && req.body.length > 0) {
    return { raw: req.body, source: 'string' };
  }
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    return { raw: req.body.toString('utf8'), source: 'buffer' };
  }
  if (
    req.body &&
    typeof req.body === 'object' &&
    !Array.isArray(req.body) &&
    !Buffer.isBuffer(req.body) &&
    Object.keys(req.body as object).length > 0
  ) {
    return {
      raw: new URLSearchParams(req.body as Record<string, string>).toString(),
      source: 'reconstructed',
    };
  }
  return { raw: '', source: 'empty' };
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
    const { raw: rawBody, source } = await readRawBody(req);
    if (!rawBody) {
      void log.error('Empty body', { source }, 'body');
      res.status(400).send('Bad request');
      return;
    }
    void log.info(`rawBody ready (${rawBody.length} bytes, source=${source})`, undefined, 'body');

    const sig = verifySlackSignature(req, rawBody);
    if (!sig.ok) {
      void log.error(`Invalid signature: ${sig.reason}`, { source, ...sig.detail }, 'sig');
      // pre-parsed が復元できないケースに備え、500 ではなく 401 を返す
      res.status(401).send('Invalid signature');
      return;
    }

    // Content-Type によって slash / interactivity / events を振り分け
    const contentType = (req.headers['content-type'] || '').toString().toLowerCase();
    const isJson = contentType.includes('application/json');

    if (isJson) {
      // --- Events API ---
      let eventBody: any = null;
      try {
        eventBody = JSON.parse(rawBody);
      } catch (e) {
        void log.error('events JSON parse failed', e, 'events');
        res.status(400).send('Bad JSON');
        return;
      }

      // url_verification は同期で challenge を返す
      if (eventBody?.type === 'url_verification' && typeof eventBody.challenge === 'string') {
        void log.info('url_verification', undefined, 'events');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ challenge: eventBody.challenge }));
        return;
      }

      if (eventBody?.type === 'event_callback') {
        const event = eventBody.event;
        void log.info('event_callback', { event_type: event?.type, user: event?.user }, 'events');

        waitUntil(
          (async () => {
            try {
              const mod = await import('../src/slack-process-command.js');
              await mod.processSlackEvent(event, reqId);
              await log.info('bg: event done', undefined, 'bg');
            } catch (err) {
              await log.error('bg event error', err, 'bg');
            }
          })()
        );

        res.writeHead(200, { 'Content-Length': '0' });
        res.end();
        void log.info(`ACK 200 (events) sent (+${Date.now() - t0}ms)`, undefined, 'ack');
        return;
      }

      void log.warn('unknown json event type', { type: eventBody?.type }, 'events');
      res.writeHead(200, { 'Content-Length': '0' });
      res.end();
      return;
    }

    // --- Slash command or Interactivity (form-urlencoded) ---
    params = parseBody(rawBody);
    void log.info(
      'verified',
      {
        command: params.command,
        user_id: params.user_id,
        text_len: (params.text || '').length,
        isPayload: !!params.payload,
        source,
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

  if (!params) {
    if (!res.headersSent) {
      res.writeHead(200, { 'Content-Length': '0' });
      res.end();
    }
    return;
  }

  const capturedParams = params;
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
