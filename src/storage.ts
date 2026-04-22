import { kv } from '@vercel/kv';
import { UserTokens, BookmarkCache, XBookmark } from './types.js';

const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL_KV_REST_API_URL;

// Simple in-memory fallback for local development (non-persistent across restarts)
// For production, Vercel KV is always used
const memStore = new Map<string, any>();

async function kvGet<T>(key: string): Promise<T | null> {
  if (isVercel) {
    return await kv.get<T>(key);
  }
  return memStore.get(key) ?? null;
}

async function kvSet(key: string, value: any, exSeconds?: number): Promise<void> {
  if (isVercel) {
    if (exSeconds) {
      await kv.set(key, value, { ex: exSeconds });
    } else {
      await kv.set(key, value);
    }
  } else {
    memStore.set(key, value);
    console.log(`[MemStore] SET ${key}`);
  }
}

async function kvDel(key: string): Promise<void> {
  if (isVercel) {
    await kv.del(key);
  } else {
    memStore.delete(key);
  }
}

export class Storage {
  private static instance: Storage;

  static getInstance(): Storage {
    if (!Storage.instance) {
      Storage.instance = new Storage();
    }
    return Storage.instance;
  }

  async saveUserTokens(slackUserId: string, tokens: Omit<UserTokens, 'slackUserId' | 'createdAt'>): Promise<void> {
    const userTokens: UserTokens = {
      ...tokens,
      slackUserId,
      createdAt: new Date().toISOString(),
    };
    await kvSet(`tokens:${slackUserId}`, userTokens, 60 * 60 * 24 * 30);
    console.log(`[Storage] Saved tokens for Slack user ${slackUserId}`);
  }

  async getUserTokens(slackUserId: string): Promise<UserTokens | null> {
    return await kvGet<UserTokens>(`tokens:${slackUserId}`);
  }

  async saveBookmarkCache(userId: string, bookmarks: XBookmark[], totalFetched: number): Promise<void> {
    const cache: BookmarkCache = {
      userId,
      bookmarks,
      lastSynced: new Date().toISOString(),
      totalFetched,
    };
    await kvSet(`cache:${userId}`, cache, 60 * 60 * 24 * 7);
    console.log(`[Storage] Saved ${bookmarks.length} bookmarks for ${userId}`);
  }

  async getBookmarkCache(userId: string): Promise<BookmarkCache | null> {
    return await kvGet<BookmarkCache>(`cache:${userId}`);
  }

  async deleteUserData(slackUserId: string): Promise<void> {
    await kvDel(`tokens:${slackUserId}`);
    await kvDel(`cache:${slackUserId}`);
    console.log(`[Storage] Deleted data for user ${slackUserId}`);
  }
}

export const storage = Storage.getInstance();
export default storage;
