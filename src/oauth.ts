import crypto from 'crypto';
import { kv } from '@vercel/kv';
import { storage } from './storage.js';
import { WebClient } from '@slack/web-api';

const X_AUTH_URL = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://x-bookmark-grok-recommender.vercel.app/api/oauth/callback'; // ← 本番URLに変更してください

// Scopes required for bookmarks (bookmark.read is mandatory)
const SCOPES = 'bookmark.read tweet.read users.read offline.access tweet.write offline.access';

export function generatePKCE() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url');
  
  return { verifier, challenge };
}

export async function createAuthUrl(slackUserId: string, stateData: any = {}): Promise<string> {
  const { verifier, challenge } = generatePKCE();
  const stateObj = {
    slackUserId,
    timestamp: Date.now(),
    ...stateData,
  };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');

  // Store verifier in Vercel KV with 10 minute TTL (secure PKCE)
  await kv.set(`pkce:${state}`, verifier, { ex: 600 });
  console.log(`[OAuth] Stored PKCE verifier for state (slackUserId=${slackUserId})`);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: process.env.X_CLIENT_ID!,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return `${X_AUTH_URL}?${params.toString()}`;
}

export async function handleOAuthCallback(code: string, state: string): Promise<{ success: boolean; slackUserId?: string; error?: string }> {
  let stateObj;
  try {
    stateObj = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch (e) {
    return { success: false, error: 'Invalid state encoding' };
  }
  
  const { slackUserId } = stateObj;

  if (!slackUserId) {
    return { success: false, error: 'Invalid state: missing slackUserId' };
  }

  // Retrieve PKCE verifier from KV
  const verifier = await kv.get<string>(`pkce:${state}`);
  if (!verifier) {
    console.error('[OAuth] PKCE verifier not found or expired for state');
    return { success: false, error: 'PKCE verifier expired. Please try logging in again.' };
  }

  // Clean up immediately
  await kv.del(`pkce:${state}`);

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: process.env.X_CLIENT_ID!,
      code_verifier: verifier,
    });

    const response = await fetch(X_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[OAuth] Token exchange failed:', errText);
      return { success: false, error: 'トークン取得に失敗しました' };
    }

    const tokenData = await response.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    await storage.saveUserTokens(slackUserId, {
      xAccessToken: access_token,
      xRefreshToken: refresh_token,
      xTokenExpiresAt: Date.now() + (expires_in * 1000),
    });

    // Clean up
    if ((globalThis as any).pkceStore) {
      ((globalThis as any).pkceStore as Map<string, string>).delete(state);
    }

    console.log(`[OAuth] Successfully authenticated Slack user ${slackUserId}`);
    return { success: true, slackUserId };
  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    return { success: false, error: '認証処理中にエラーが発生しました' };
  }
}

// Slack action to send login button via DM
export async function sendXLoginDM(client: WebClient, slackUserId: string): Promise<void> {
  const authUrl = await createAuthUrl(slackUserId);

  try {
    await client.chat.postMessage({
      channel: slackUserId,
      text: 'X Bookmark Grok Recommender を使用するには、Xアカウントでログインが必要です。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*X Bookmark Grok Recommender* 🚀\n\nXのブックマークをGrokが賢く推薦します！\n\n*初回利用時はXログインが必要です*',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Xでログイン',
                emoji: true,
              },
              style: 'primary',
              url: authUrl,
              action_id: 'x_login_button',
            },
          ],
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: '🔒 安全なOAuth2.0 (PKCE) を使用。bookmark.readスコープのみ要求します。',
            },
          ],
        },
      ],
    });
    console.log(`[OAuth] Sent login DM to ${slackUserId}`);
  } catch (error) {
    console.error('[OAuth] Failed to send DM:', error);
    throw error;
  }
}
