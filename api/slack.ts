import { createSlackApp } from '../src/app.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const appPromise = createSlackApp();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const app = await appPromise;
    
    // Bolt handles the request (HTTPReceiver)
    if (app.receiver && 'requestHandler' in app.receiver) {
      await (app.receiver as any).requestHandler(req as any, res as any);
    } else {
      res.status(500).json({ error: 'Receiver not initialized' });
    }
  } catch (error: any) {
    console.error('Vercel handler error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Slackボットの処理中にエラーが発生しました。',
    });
  }
}
