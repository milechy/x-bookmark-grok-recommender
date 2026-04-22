import type { VercelRequest, VercelResponse } from '@vercel/node';
import { processSlackCommand } from '../src/slack-process-command.js';

function getWorkerSecret(): string {
  const s = process.env.SLACK_WORKER_SECRET || process.env.SLACK_SIGNING_SECRET;
  if (!s) {
    throw new Error('SLACK_WORKER_SECRET or SLACK_SIGNING_SECRET is required');
  }
  return s;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  try {
    const auth = req.headers.authorization;
    const expected = `Bearer ${getWorkerSecret()}`;
    if (!auth || auth !== expected) {
      console.error('[slack-background] Unauthorized');
      res.status(401).send('Unauthorized');
      return;
    }

    const body = req.body;
    const params =
      typeof body === 'string' ? (JSON.parse(body) as Record<string, string>) : (body as Record<string, string>);
    if (!params || typeof params !== 'object') {
      res.status(400).send('Bad request');
      return;
    }

    await processSlackCommand(params);
    res.status(200).json({ ok: true });
  } catch (e: unknown) {
    console.error('[slack-background]', e);
    const msg = e instanceof Error ? e.message : 'Internal error';
    if (!res.headersSent) {
      res.status(500).json({ error: msg });
    }
  }
}
