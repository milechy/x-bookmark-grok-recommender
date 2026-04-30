/**
 * Vercel Cron 専用エンドポイント: 1 日 1 回 (06:00 JST = 21:00 UTC)
 *
 * 処理:
 *   1. CRON_SECRET で認証
 *   2. 対象ユーザー (env CRON_USER_SLACK_IDS, カンマ区切り) を取得
 *   3. 各ユーザーで:
 *      a. X bookmark を強制再取得 (forceSync = true)
 *      b. obsidian:imported:<userId> KV と diff を取り、未取り込み分のみ抽出
 *      c. Obsidian に書き込み (writeBookmarksToObsidian)
 *      d. 取り込んだ ID を obsidian:imported に追加 (永続)
 *      e. 任意: Slack DM で結果を通知
 *   4. JSON サマリを返す
 *
 * 手動トリガー: GET /api/cron/bookmark-sync?secret=<CRON_SECRET>
 * Vercel Cron からは Authorization: Bearer <CRON_SECRET> が自動付与される。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storage } from '../../src/storage.js';
import { XService } from '../../src/services/x.js';
import {
  writeBookmarksToObsidian,
  detectObsidianMode,
  describeMode,
} from '../../src/services/obsidian-writer.js';
import {
  getImportedIds,
  addImportedIds,
} from '../../src/services/obsidian-imported.js';
import { DebugLogger, newReqId } from '../../src/debug-log.js';

interface UserResult {
  slackUserId: string;
  ok: boolean;
  totalFetched?: number;
  newCount?: number;
  written?: number;
  failed?: number;
  mode?: string;
  error?: string;
  paths?: string[];
}

function isAuthorized(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth === `Bearer ${secret}`) return true;
  const q = (req.query.secret as string | undefined) ?? '';
  return q === secret;
}

function getTargetUserIds(): string[] {
  const raw = process.env.CRON_USER_SLACK_IDS ?? process.env.CRON_USER_SLACK_ID ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function notifySlackDM(
  slackUserId: string,
  text: string,
  log: DebugLogger
): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) return;
  try {
    const { WebClient } = await import('@slack/web-api');
    const client = new WebClient(botToken);
    const im = await client.conversations.open({ users: slackUserId });
    const channel = im.channel?.id;
    if (!channel) return;
    await client.chat.postMessage({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  } catch (e) {
    await log.warn('DM notify failed', { error: String(e) }, 'cron');
  }
}

async function syncOneUser(
  slackUserId: string,
  log: DebugLogger
): Promise<UserResult> {
  await log.info('cron: sync start', { slackUserId }, 'cron');

  const tokens = await storage.getUserTokens(slackUserId);
  if (!tokens) {
    return { slackUserId, ok: false, error: 'no tokens (user not authenticated)' };
  }

  const x = new XService(tokens.xAccessToken, slackUserId);
  let bookmarks: Awaited<ReturnType<XService['getAllBookmarks']>>;
  try {
    bookmarks = await x.getAllBookmarks(true, slackUserId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error('cron: fetch bookmarks failed', { slackUserId, msg }, 'cron');
    return { slackUserId, ok: false, error: `fetch failed: ${msg}` };
  }

  const imported = await getImportedIds(slackUserId);
  const newOnes = bookmarks.filter((b) => !imported.has(b.id));

  const mode = detectObsidianMode();
  const modeLabel = describeMode(mode);

  if (newOnes.length === 0) {
    await log.info(
      'cron: no new bookmarks',
      { slackUserId, totalFetched: bookmarks.length, importedCount: imported.size },
      'cron'
    );
    return {
      slackUserId,
      ok: true,
      totalFetched: bookmarks.length,
      newCount: 0,
      written: 0,
      failed: 0,
      mode: modeLabel,
    };
  }

  let result;
  try {
    result = await writeBookmarksToObsidian({ bookmarks: newOnes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error('cron: obsidian write failed', { slackUserId, msg }, 'cron');
    return { slackUserId, ok: false, error: `obsidian write failed: ${msg}` };
  }

  const writtenIds = result.written.map((w) => w.tweetId);
  if (writtenIds.length > 0) {
    await addImportedIds(slackUserId, writtenIds);
  }

  await log.info(
    'cron: sync done',
    {
      slackUserId,
      mode: result.mode,
      newCount: newOnes.length,
      written: result.written.length,
      failed: result.failed.length,
    },
    'cron'
  );

  // Slack DM で通知（slack-upload モードはファイルアップロードが必要なのでスキップ）
  if (result.mode !== 'slack-upload' && result.written.length > 0) {
    const summaryLines = [
      `🌅 *おはようございます。新規ブックマーク ${result.written.length} 件を Obsidian に取り込みました*`,
      `モード: ${modeLabel}`,
      ...result.written.slice(0, 5).map((w) => `• \`${w.path}\``),
    ];
    if (result.written.length > 5) {
      summaryLines.push(`…他 ${result.written.length - 5} 件`);
    }
    if (result.failed.length > 0) {
      summaryLines.push(`⚠️ 失敗 ${result.failed.length} 件`);
    }
    await notifySlackDM(slackUserId, summaryLines.join('\n'), log);
  }

  return {
    slackUserId,
    ok: true,
    totalFetched: bookmarks.length,
    newCount: newOnes.length,
    written: result.written.length,
    failed: result.failed.length,
    mode: modeLabel,
    paths: result.written.map((w) => w.path),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const reqId = newReqId('cron');
  const log = new DebugLogger(reqId);

  if (!isAuthorized(req)) {
    await log.warn('cron: unauthorized', { url: req.url }, 'cron');
    return res.status(401).json({ error: 'unauthorized' });
  }

  const targetUsers = getTargetUserIds();
  if (targetUsers.length === 0) {
    await log.error(
      'cron: no target users (set CRON_USER_SLACK_IDS env)',
      undefined,
      'cron'
    );
    return res.status(500).json({
      error:
        'CRON_USER_SLACK_IDS not configured (e.g. "U01ABC123" or "U01ABC123,U02XYZ456")',
    });
  }

  await log.info('cron: bookmark-sync start', { targetUsers, reqId }, 'cron');

  const results: UserResult[] = [];
  for (const userId of targetUsers) {
    try {
      const r = await syncOneUser(userId, log);
      results.push(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log.error('cron: user sync threw', { userId, msg }, 'cron');
      results.push({ slackUserId: userId, ok: false, error: msg });
    }
  }

  const summary = {
    reqId,
    timestamp: new Date().toISOString(),
    targetCount: targetUsers.length,
    successCount: results.filter((r) => r.ok).length,
    failureCount: results.filter((r) => !r.ok).length,
    totalNewBookmarks: results.reduce((s, r) => s + (r.newCount ?? 0), 0),
    totalWritten: results.reduce((s, r) => s + (r.written ?? 0), 0),
    results,
  };

  await log.info('cron: bookmark-sync done', summary, 'cron');

  return res.status(200).json(summary);
}

export const config = {
  maxDuration: 60,
};
