/**
 * Slack エントリ（Edge）。コールドスタートを抑え 3 秒以内に必ず 200 を返す。
 * 実処理は Node の /api/slack-background へ委譲（waitUntil + fetch）。
 */
import { waitUntil } from '@vercel/functions';
import { verifySlackSignatureWeb } from '../src/slack-signature-edge.js';

export const config = {
  runtime: 'edge',
};

function parseBody(rawBody: string): Record<string, string> {
  const params: Record<string, string> = {};
  new URLSearchParams(rawBody).forEach((v, k) => {
    params[k] = v;
  });
  return params;
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'X Bookmark Grok Recommender Slack Endpoint (Edge)',
        env_check: {
          SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN,
          SLACK_SIGNING_SECRET: !!process.env.SLACK_SIGNING_SECRET,
          GROK_API_KEY: !!process.env.GROK_API_KEY,
          X_CLIENT_ID: !!process.env.X_CLIENT_ID,
          KV_REST_API_URL: !!process.env.KV_REST_API_URL || !!process.env.VERCEL_KV_REST_API_URL,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } }
    );
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const rawBody = await request.text();
  if (!rawBody) {
    return new Response('Bad request', { status: 400 });
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return new Response('Server misconfiguration', { status: 500 });
  }

  const valid = await verifySlackSignatureWeb(
    signingSecret,
    request.headers.get('x-slack-request-timestamp'),
    request.headers.get('x-slack-signature'),
    rawBody
  );

  if (!valid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const params = parseBody(rawBody);
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host');
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const origin = host ? `${proto}://${host}` : url.origin;

  const workerSecret = process.env.SLACK_WORKER_SECRET || process.env.SLACK_SIGNING_SECRET;
  if (!workerSecret) {
    return new Response('Server misconfiguration', { status: 500 });
  }

  // 同一 Vercel デプロイに確実に飛ばす（x-forwarded-host ずれで内部 fetch が外れるのを防ぐ）
  const bgUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}/api/slack-background`
    : `${origin}/api/slack-background`;

  waitUntil(
    fetch(bgUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify(params),
    }).catch((err) => console.error('[Slack] background fetch failed:', err))
  );

  return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
