/**
 * Obsidian に「自動取り込み済み」のブックマーク ID を KV に永続記録する。
 *
 * - `seen:<userId>` (slack-process-command.ts) は **「直近の推薦結果に表示済み」** を 7 日 TTL で管理
 * - こちらは **「Obsidian vault に既に書き込まれた」** を **TTL なし（永続）** で管理
 *
 * cron から「新規ブックマークだけ」を vault へ同期するための差分判定に使う。
 */
import { kv } from '@vercel/kv';

const isVercel =
  process.env.VERCEL === '1' ||
  !!process.env.VERCEL_KV_REST_API_URL ||
  !!process.env.KV_REST_API_URL;

const memSets = new Map<string, Set<string>>();

function key(slackUserId: string): string {
  return `obsidian:imported:${slackUserId}`;
}

export async function getImportedIds(slackUserId: string): Promise<Set<string>> {
  if (!isVercel) {
    return new Set(memSets.get(key(slackUserId)) ?? []);
  }
  try {
    const ids = (await kv.smembers(key(slackUserId))) as string[] | null;
    return new Set(Array.isArray(ids) ? ids : []);
  } catch (e) {
    console.warn('[obsidian-imported] get failed', e);
    return new Set<string>();
  }
}

export async function addImportedIds(slackUserId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!isVercel) {
    const set = memSets.get(key(slackUserId)) ?? new Set<string>();
    for (const id of ids) set.add(id);
    memSets.set(key(slackUserId), set);
    return;
  }
  try {
    await kv.sadd(key(slackUserId), ids[0], ...ids.slice(1));
  } catch (e) {
    console.warn('[obsidian-imported] add failed', e);
  }
}

export async function clearImportedIds(slackUserId: string): Promise<void> {
  if (!isVercel) {
    memSets.delete(key(slackUserId));
    return;
  }
  try {
    await kv.del(key(slackUserId));
  } catch (e) {
    console.warn('[obsidian-imported] clear failed', e);
  }
}
