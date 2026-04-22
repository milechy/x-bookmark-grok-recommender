import { createSlackApp } from '../src/app.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const appPromise = createSlackApp();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const app = await appPromise;
    
    // Bolt handles the request
    await app.receiver!.requestHandler(req as any, res as any);
  } catch (error) {
    console.error('Vercel handler error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Slackボットの処理中にエラーが発生しました。',
    });
  }
}

// For OAuth callback (separate endpoint)
export { default as oauthCallback } from './oauth/callback.js';
