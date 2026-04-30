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
  toProcessThisRun?: number;
  written?: number;
  failed?: number;
  mode?: string;
  error?: string;
  paths?: string[];
  remaining?: number;
  backfilled?: number;
}

const DEFAULT_PER_RUN_LIMIT = 50;

function getPerRunLimit(): number {
  const raw = process.env.CRON_MAX_PER_RUN;
  if (!raw) return DEFAULT_PER_RUN_LIMIT;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_RUN_LIMIT;
  return n;
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

/**
 * vault (GitHub) の 00_Inbox/X-Bookmarks/ にある既存ファイルから tweet ID を抽出。
 * ファイル名形式 "YYYY-MM-DD-<TweetID>.md" を前提。
 */
async function listExistingTweetIdsInVault(): Promise<{
  ok: boolean;
  ids: string[];
  reason?: string;
}> {
  const repo = process.env.OBSIDIAN_GITHUB_REPO;
  const token = process.env.OBSIDIAN_GITHUB_TOKEN;
  const branch = process.env.OBSIDIAN_GITHUB_BRANCH || 'main';
  const folder = process.env.OBSIDIAN_NOTE_FOLDER || '00_Inbox/X-Bookmarks';
  if (!repo || !token) {
    return { ok: false, ids: [], reason: 'GITHUB env not set' };
  }
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURI(folder)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'founderos-v2',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    return {
      ok: false,
      ids: [],
      reason: `GitHub list ${res.status}: ${t.slice(0, 200)}`,
    };
  }
  const json = (await res.json()) as Array<{ name: string; type: string }>;
  const re = /-(\d{6,25})\.md$/;
  const ids: string[] = [];
  for (const item of json) {
    if (item.type !== 'file') continue;
    const m = re.exec(item.name);
    if (m) ids.push(m[1]);
  }
  return { ok: true, ids };
}

async function syncOneUser(
  slackUserId: string,
  log: DebugLogger,
  opts: { backfill: boolean; syncExisting: boolean; perRunLimit: number }
): Promise<UserResult> {
  await log.info(
    'cron: sync start',
    {
      slackUserId,
      backfill: opts.backfill,
      syncExisting: opts.syncExisting,
      perRunLimit: opts.perRunLimit,
    },
    'cron'
  );

  // -------------------- syncExisting モード --------------------
  // vault に既に存在するノートだけを imported に登録（X API ヒットなし、書き込みなし）
  if (opts.syncExisting) {
    const r = await listExistingTweetIdsInVault();
    if (!r.ok) {
      await log.error(
        'cron: syncExisting failed',
        { slackUserId, reason: r.reason },
        'cron'
      );
      return { slackUserId, ok: false, error: r.reason };
    }
    if (r.ids.length > 0) {
      await addImportedIds(slackUserId, r.ids);
    }
    await log.info(
      'cron: syncExisting done',
      { slackUserId, registered: r.ids.length },
      'cron'
    );
    await notifySlackDM(
      slackUserId,
      `📥 vault 既存ノート *${r.ids.length}* 件を「取り込み済み」として KV に登録しました\nこれ以降の cron は、これらは再取り込みされません。残りは順次取り込まれます。`,
      log
    );
    return {
      slackUserId,
      ok: true,
      backfilled: r.ids.length,
    };
  }
  // ------------------------------------------------------------

  const tokens = await storage.getUserTokens(slackUserId);
  if (!tokens) {
    return { slackUserId, ok: false, error: 'no tokens (user not authenticated)' };
  }

  const x = new XService(tokens.xAccessToken, slackUserId);
  let bookmarks: Awaited<ReturnType<XService['getAllBookmarks']>>;
  try {
    // バックフィル時はキャッシュ流用で十分（X API を再ヒットしない）
    bookmarks = await x.getAllBookmarks(!opts.backfill, slackUserId);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error('cron: fetch bookmarks failed', { slackUserId, msg }, 'cron');
    return { slackUserId, ok: false, error: `fetch failed: ${msg}` };
  }

  // -------------------- backfill モード --------------------
  if (opts.backfill) {
    const allIds = bookmarks.map((b) => b.id);
    if (allIds.length > 0) {
      await addImportedIds(slackUserId, allIds);
    }
    await log.info(
      'cron: backfill done',
      { slackUserId, backfilled: allIds.length },
      'cron'
    );
    await notifySlackDM(
      slackUserId,
      `✅ バックフィル完了: 既存 *${allIds.length}* 件を「取り込み済み」として登録しました\n明日以降の cron はこれより新しいブックマークだけを Obsidian に書き込みます。`,
      log
    );
    return {
      slackUserId,
      ok: true,
      totalFetched: bookmarks.length,
      backfilled: allIds.length,
    };
  }
  // ---------------------------------------------------------

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

  // per-run 上限を適用（タイムアウト防止）
  const toProcess = newOnes.slice(0, opts.perRunLimit);
  const remaining = newOnes.length - toProcess.length;

  await log.info(
    'cron: processing slice',
    {
      slackUserId,
      newCount: newOnes.length,
      perRunLimit: opts.perRunLimit,
      toProcess: toProcess.length,
      remaining,
    },
    'cron'
  );

  let result;
  try {
    result = await writeBookmarksToObsidian({
      bookmarks: toProcess,
      // 1 件 commit 成功するたびに imported に追加（タイムアウトしても部分成功は確実に記録される）
      onWritten: async (entry) => {
        await addImportedIds(slackUserId, [entry.tweetId]);
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log.error('cron: obsidian write failed', { slackUserId, msg }, 'cron');
    return { slackUserId, ok: false, error: `obsidian write failed: ${msg}` };
  }

  await log.info(
    'cron: sync done',
    {
      slackUserId,
      mode: result.mode,
      newCount: newOnes.length,
      written: result.written.length,
      failed: result.failed.length,
      remaining,
    },
    'cron'
  );

  // Slack DM で通知（slack-upload モードはスキップ）
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
    if (remaining > 0) {
      summaryLines.push(
        `📦 残り未取り込み ${remaining} 件は次回以降の cron で処理されます (上限/回 ${opts.perRunLimit})`
      );
    }
    await notifySlackDM(slackUserId, summaryLines.join('\n'), log);
  }

  return {
    slackUserId,
    ok: true,
    totalFetched: bookmarks.length,
    newCount: newOnes.length,
    toProcessThisRun: toProcess.length,
    written: result.written.length,
    failed: result.failed.length,
    remaining,
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

  // クエリパラメータ
  const isTrue = (v: unknown) => v === '1' || v === 'true';
  const backfill = isTrue(req.query.backfill);
  const syncExisting = isTrue(req.query.syncExisting);
  const perRunOverride = parseInt((req.query.limit as string | undefined) ?? '', 10);
  const perRunLimit = Number.isFinite(perRunOverride) && perRunOverride > 0
    ? perRunOverride
    : getPerRunLimit();

  await log.info(
    'cron: bookmark-sync start',
    { targetUsers, reqId, backfill, syncExisting, perRunLimit },
    'cron'
  );

  const results: UserResult[] = [];
  for (const userId of targetUsers) {
    try {
      const r = await syncOneUser(userId, log, { backfill, syncExisting, perRunLimit });
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
    backfill,
    syncExisting,
    perRunLimit,
    targetCount: targetUsers.length,
    successCount: results.filter((r) => r.ok).length,
    failureCount: results.filter((r) => !r.ok).length,
    totalNewBookmarks: results.reduce((s, r) => s + (r.newCount ?? 0), 0),
    totalWritten: results.reduce((s, r) => s + (r.written ?? 0), 0),
    totalRemaining: results.reduce((s, r) => s + (r.remaining ?? 0), 0),
    totalBackfilled: results.reduce((s, r) => s + (r.backfilled ?? 0), 0),
    results,
  };

  await log.info('cron: bookmark-sync done', summary, 'cron');

  return res.status(200).json(summary);
}

export const config = {
  maxDuration: 60,
};
