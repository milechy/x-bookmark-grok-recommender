import { kv } from '@vercel/kv';
import { existsSync, mkdirSync } from 'fs';
import path from 'path';
import { UserTokens, BookmarkCache, XBookmark } from './types.js';

// better-sqlite3 is a native module - only load dynamically in non-Vercel environments
// Top-level import would crash Vercel Lambda (different platform binary)
const isVercel = process.env.VERCEL === '1' || !!process.env.VERCEL_KV_REST_API_URL;

let _db: any = null;

function getDb(): any {
  if (!isVercel && !_db) {
    // Dynamic require to avoid crashing Vercel Lambda
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const DATA_DIR = path.join(process.cwd(), 'data');
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
    const DB_PATH = process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'bookmarks.db');
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS user_tokens (
        slack_user_id TEXT PRIMARY KEY,
        x_access_token TEXT NOT NULL,
        x_refresh_token TEXT,
        x_token_expires_at INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS bookmark_caches (
        user_id TEXT PRIMARY KEY,
        bookmarks TEXT NOT NULL,
        last_synced TEXT NOT NULL,
        total_fetched INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_slack ON user_tokens(slack_user_id);
      CREATE INDEX IF NOT EXISTS idx_cache_user ON bookmark_caches(user_id);
    `);
  }
  return _db;
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

    if (isVercel) {
      await kv.set(`tokens:${slackUserId}`, userTokens, { ex: 60 * 60 * 24 * 30 });
      console.log(`[KV] Saved tokens for Slack user ${slackUserId}`);
    } else {
      const stmt = getDb().prepare(`
        INSERT OR REPLACE INTO user_tokens 
        (slack_user_id, x_access_token, x_refresh_token, x_token_expires_at)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(slackUserId, tokens.xAccessToken, tokens.xRefreshToken || null, tokens.xTokenExpiresAt || null);
      console.log(`[SQLite] Saved tokens for Slack user ${slackUserId}`);
    }
  }

  async getUserTokens(slackUserId: string): Promise<UserTokens | null> {
    if (isVercel) {
      return await kv.get<UserTokens>(`tokens:${slackUserId}`);
    } else {
      const stmt = getDb().prepare('SELECT * FROM user_tokens WHERE slack_user_id = ?');
      const row = stmt.get(slackUserId) as any;
      if (!row) return null;
      return {
        slackUserId: row.slack_user_id,
        xAccessToken: row.x_access_token,
        xRefreshToken: row.x_refresh_token,
        xTokenExpiresAt: row.x_token_expires_at,
        createdAt: row.created_at,
      };
    }
  }

  async saveBookmarkCache(userId: string, bookmarks: XBookmark[], totalFetched: number): Promise<void> {
    const cache: BookmarkCache = {
      userId,
      bookmarks,
      lastSynced: new Date().toISOString(),
      totalFetched,
    };

    if (isVercel) {
      await kv.set(`cache:${userId}`, cache, { ex: 60 * 60 * 24 * 7 });
      console.log(`[KV] Saved bookmark cache for user ${userId} (${bookmarks.length} bookmarks)`);
    } else {
      const stmt = getDb().prepare(`
        INSERT OR REPLACE INTO bookmark_caches 
        (user_id, bookmarks, last_synced, total_fetched)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(userId, JSON.stringify(bookmarks), cache.lastSynced, totalFetched);
      console.log(`[SQLite] Saved bookmark cache for user ${userId}`);
    }
  }

  async getBookmarkCache(userId: string): Promise<BookmarkCache | null> {
    if (isVercel) {
      return await kv.get<BookmarkCache>(`cache:${userId}`);
    } else {
      const stmt = getDb().prepare('SELECT * FROM bookmark_caches WHERE user_id = ?');
      const row = stmt.get(userId) as any;
      if (!row) return null;
      return {
        userId: row.user_id,
        bookmarks: JSON.parse(row.bookmarks),
        lastSynced: row.last_synced,
        totalFetched: row.total_fetched,
      };
    }
  }

  async deleteUserData(slackUserId: string): Promise<void> {
    if (isVercel) {
      await kv.del(`tokens:${slackUserId}`);
      await kv.del(`cache:${slackUserId}`);
    } else {
      const db = getDb();
      db.prepare('DELETE FROM user_tokens WHERE slack_user_id = ?').run(slackUserId);
      db.prepare('DELETE FROM bookmark_caches WHERE user_id = ?').run(slackUserId);
    }
    console.log(`[Storage] Deleted data for user ${slackUserId}`);
  }
}

export const storage = Storage.getInstance();
export default storage;
