/**
 * Obsidian 連携の Slack 側フロー。
 *
 * - /bookmark-to-obsidian [N|all] を受けて、キャッシュ済みブックマークを N 件保存
 * - block_actions: action_id="obs_save_displayed" を受けて、表示中の推薦 8 件を保存
 *
 * slack-process-command.ts に手を入れる量を最小化するため、
 * 自分で Responder と DebugLogger を組み立てる。
 */
import { WebClient } from '@slack/web-api';
import { storage } from '../storage.js';
import { DebugLogger, newReqId } from '../debug-log.js';
import {
  writeBookmarksToObsidian,
  detectObsidianMode,
  describeMode,
  type ObsidianWriteResult,
} from './obsidian-writer.js';
import type { XBookmark } from '../types.js';

export const OBSIDIAN_ACTION_PREFIX = 'obs_';

/** action_id が Obsidian 関連か */
export function isObsidianActionId(actionId?: string): boolean {
  return !!actionId && actionId.startsWith(OBSIDIAN_ACTION_PREFIX);
}

/* -------------------------------------------------------------------------- */
/* Slash command: /bookmark-to-obsidian                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_SAVE_COUNT = 20;
const MAX_SAVE_COUNT = 100;

/**
 * /bookmark-to-obsidian            → 直近 20 件をキャッシュから保存
 * /bookmark-to-obsidian 50         → 直近 50 件
 * /bookmark-to-obsidian all        → キャッシュ全件（最大 100）
 * /bookmark-to-obsidian help       → 使い方
 */
export async function processObsidianCommand(
  params: Record<string, string>,
  reqId?: string
): Promise<void> {
  const log = new DebugLogger(reqId ?? newReqId('obs'));
  const userId = params.user_id;
  const responseUrl = params.response_url;
  const text = (params.text || '').trim().toLowerCase();

  await log.info(
    'processObsidianCommand start',
    { user_id: userId, arg: text, mode: detectObsidianMode() },
    'obs'
  );

  if (!responseUrl) {
    await log.error('response_url missing', undefined, 'obs');
    return;
  }

  if (text === 'help' || text === '?') {
    await postEphemeral(responseUrl, helpText());
    return;
  }

  try {
    const cache = await storage.getBookmarkCache(userId);
    if (!cache || cache.bookmarks.length === 0) {
      await postEphemeral(
        responseUrl,
        '❌ ブックマークキャッシュがありません。先に `/bookmark-sync` または `/bookmark <要件>` を実行してください。'
      );
      return;
    }

    let count = DEFAULT_SAVE_COUNT;
    if (text === 'all') {
      count = MAX_SAVE_COUNT;
    } else if (text) {
      const parsed = parseInt(text, 10);
      if (!isNaN(parsed) && parsed > 0) {
        count = Math.min(parsed, MAX_SAVE_COUNT);
      }
    }

    const items = cache.bookmarks.slice(0, count);
    await postEphemeral(
      responseUrl,
      `📝 *${items.length}件* を Obsidian に保存中… モード: *${describeMode(detectObsidianMode())}*`
    );

    const result = await writeBookmarksToObsidian({ bookmarks: items });
    await log.info(
      'obsidian write done',
      { mode: result.mode, ok: result.written.length, ng: result.failed.length },
      'obs'
    );

    await postEphemeral(responseUrl, summaryText(result), summaryBlocks(result));

    if (result.mode === 'slack-upload' && result.files && result.files.length > 0) {
      await uploadFilesToSlack(userId, result.files, log);
    }
  } catch (e) {
    await log.error('processObsidianCommand failed', e, 'obs');
    await postEphemeral(
      responseUrl,
      `❌ Obsidian保存でエラー: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/* block_actions: 推薦結果から「Obsidianに保存」                                */
/* -------------------------------------------------------------------------- */

/**
 * action_id = "obs_save_displayed"
 * value = "<id1>,<id2>,..." (カンマ区切りの tweet_id 群)
 */
export async function processObsidianAction(payload: any, reqId?: string): Promise<void> {
  const log = new DebugLogger(reqId ?? newReqId('obs'));
  const action = payload?.actions?.[0];
  const userId: string | undefined = payload?.user?.id;
  const value: string = (action?.value || '').toString();

  await log.info(
    'processObsidianAction start',
    { action_id: action?.action_id, user_id: userId, value_len: value.length },
    'obs'
  );

  if (!userId) {
    await log.error('user_id missing', undefined, 'obs');
    return;
  }

  try {
    const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
    const cache = await storage.getBookmarkCache(userId);

    if (!cache || cache.bookmarks.length === 0) {
      await sendDM(userId, '❌ ブックマークキャッシュがありません。先に `/bookmark-sync` を実行してください。');
      return;
    }

    let items: XBookmark[];
    if (ids.length > 0) {
      const map = new Map(cache.bookmarks.map((b) => [b.id, b] as const));
      items = ids.map((id) => map.get(id)).filter((b): b is XBookmark => !!b);
    } else {
      items = cache.bookmarks.slice(0, 8);
    }

    if (items.length === 0) {
      await sendDM(userId, '❌ 保存対象のブックマークがキャッシュ内に見つかりませんでした。');
      return;
    }

    await sendDM(
      userId,
      `📝 推薦された *${items.length}* 件を Obsidian に保存します… モード: *${describeMode(detectObsidianMode())}*`
    );

    const result = await writeBookmarksToObsidian({ bookmarks: items });
    await log.info(
      'obsidian action write done',
      { mode: result.mode, ok: result.written.length, ng: result.failed.length },
      'obs'
    );

    await sendDM(userId, summaryText(result), summaryBlocks(result));

    if (result.mode === 'slack-upload' && result.files && result.files.length > 0) {
      await uploadFilesToSlack(userId, result.files, log);
    }
  } catch (e) {
    await log.error('processObsidianAction failed', e, 'obs');
    await sendDM(userId, `❌ Obsidian保存でエラー: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Presentation                                                                */
/* -------------------------------------------------------------------------- */

function summaryText(r: ObsidianWriteResult): string {
  const head =
    r.mode === 'local'
      ? '📝 Obsidian (ローカル) に保存しました'
      : r.mode === 'github'
        ? '📝 Obsidian (GitHub) に保存しました'
        : '📝 .md ファイルを Slack DM にアップロードしました';
  return `${head}: 成功 ${r.written.length} 件 / 失敗 ${r.failed.length} 件`;
}

function summaryBlocks(r: ObsidianWriteResult): unknown[] {
  const head =
    r.mode === 'local'
      ? '📝 *Obsidian (ローカル)* に保存しました'
      : r.mode === 'github'
        ? '📝 *Obsidian (GitHub)* に保存しました'
        : '📝 *.md ファイル* を Slack DM にアップロードしました';

  const detail =
    r.mode === 'github' && r.written.length > 0
      ? `\n\n*書き込み先:*\n${r.written
          .slice(0, 10)
          .map((w) => `• \`${w.path}\``)
          .join('\n')}${r.written.length > 10 ? `\n_…他 ${r.written.length - 10} 件_` : ''}`
      : '';

  const blocks: unknown[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${head}\n成功: *${r.written.length}* 件 ／ 失敗: *${r.failed.length}* 件${detail}`,
      },
    },
  ];

  if (r.failed.length > 0) {
    const sample = r.failed.slice(0, 3).map((f) => `• \`${f.tweetId}\` — ${f.error}`).join('\n');
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `失敗詳細（先頭3件）:\n${sample}` }],
    });
  }

  if (r.mode === 'slack-upload') {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            '_💡 GitHub モードに切り替えると vault に直接 commit できます。' +
            '`OBSIDIAN_GITHUB_REPO` と `OBSIDIAN_GITHUB_TOKEN` を設定してください。_',
        },
      ],
    });
  }

  return blocks;
}

function helpText(): string {
  return [
    '*📝 /bookmark-to-obsidian の使い方*',
    '',
    '• `/bookmark-to-obsidian` — 直近 20 件をキャッシュから保存',
    '• `/bookmark-to-obsidian 50` — 直近 50 件',
    '• `/bookmark-to-obsidian all` — キャッシュ全件（最大 100）',
    '• `/bookmark-to-obsidian help` — このヘルプ',
    '',
    `現在のモード: *${describeMode(detectObsidianMode())}*`,
    '',
    '_推薦結果の「📝 Obsidianに保存」ボタンからは、その8件のみを保存できます。_',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Slack helpers                                                               */
/* -------------------------------------------------------------------------- */

async function postEphemeral(responseUrl: string, text: string, blocks?: unknown[]): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      response_type: 'ephemeral',
      text,
      ...(blocks ? { blocks } : {}),
    }),
  });
}

async function sendDM(userId: string, text: string, blocks?: unknown[]): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('[obsidian-flow] SLACK_BOT_TOKEN missing');
    return;
  }
  const client = new WebClient(token);
  await client.chat.postMessage({
    channel: userId,
    text,
    ...(blocks ? { blocks: blocks as any } : {}),
    unfurl_links: false,
    unfurl_media: false,
  });
}

const SLACK_UPLOAD_LIMIT = 20;

async function uploadFilesToSlack(
  userId: string,
  files: Array<{ filename: string; content: string }>,
  log: DebugLogger
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  const client = new WebClient(token);

  const targets = files.slice(0, SLACK_UPLOAD_LIMIT);
  let okCount = 0;
  for (const f of targets) {
    try {
      await client.filesUploadV2({
        channel_id: userId,
        filename: f.filename,
        title: f.filename,
        content: f.content,
      });
      okCount++;
    } catch (e) {
      await log.warn('files.uploadV2 failed', { filename: f.filename, err: String(e) }, 'obs');
    }
  }
  await log.info('uploads done', { ok: okCount, total: targets.length }, 'obs');

  if (files.length > SLACK_UPLOAD_LIMIT) {
    await sendDM(
      userId,
      `_（Slack DM の上限により ${SLACK_UPLOAD_LIMIT} 件のみアップロードしました。残り ${files.length - SLACK_UPLOAD_LIMIT} 件は GitHub モードで保存できます）_`
    );
  }
}
