import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.status(200).json({
    status: 'ok',
    message: 'Vercel function routing works! 🎉',
    timestamp: new Date().toISOString(),
  });
}
