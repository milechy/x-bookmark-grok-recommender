/**
 * Slash コマンド & インタラクティブ（モーダル）の実処理。Node ランタイム向け。
 */
import { WebClient } from '@slack/web-api';
import type { Recommendation } from './types.js';
import { DebugLogger, newReqId } from './debug-log.js';

const MAX_SECTION_TEXT = 2800;
function shrinkMrkdwn(s: string, max: number = MAX_SECTION_TEXT): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Slack `response_url` に JSON POST。`{ok:false}` も例外化。 */
export async function sendDelayedResponse(
  responseUrl: string,
  payload: unknown,
  options?: { label?: string }
): Promise<Response> {
  const label = options?.label ?? 'response_url';
  const r = await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const bodyText = await r.text();
  if (!r.ok) {
    console.error(`[${label}] Slack HTTP`, r.status, bodyText);
    throw new Error(`Slack response_url: ${r.status} ${bodyText.slice(0, 500)}`);
  }
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { ok?: boolean; error?: string };
      if (j && j.ok === false) {
        console.error(`[${label}] Slack ok:false`, j.error, bodyText);
        throw new Error(j.error || 'response_url failed');
      }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return r;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}（${ms / 1000}秒）でタイムアウトしました`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Responder 抽象：スラッシュ と モーダル(DM) の両方から同じフローを呼べるように。 */
/* -------------------------------------------------------------------------- */

type FinalPayload = { text?: string; blocks?: unknown[]; replace_original?: boolean };

interface Responder {
  progress(text: string): Promise<void>;
  final(payload: FinalPayload): Promise<void>;
  error(text: string, blocks?: unknown[]): Promise<void>;
}

function makeSlashResponder(
  channel_id: string | undefined,
  user_id: string,
  response_url: string
): Responder {
  const token = process.env.SLACK_BOT_TOKEN;
  const client = token ? new WebClient(token) : undefined;

  return {
    async progress(text) {
      if (client && channel_id) {
        try {
          const r = await client.chat.postEphemeral({
            channel: channel_id,
            user: user_id,
            text: shrinkMrkdwn(text, 10_000),
          });
          if (r.ok) return;
          console.error('[Slack] postEphemeral not ok', r.error);
        } catch (e) {
          console.error('[Slack] postEphemeral', e);
        }
      }
      await sendDelayedResponse(
        response_url,
        { response_type: 'ephemeral', text: shrinkMrkdwn(text) },
        { label: 'progress-fallback' }
      );
    },
    async final(payload) {
      await sendDelayedResponse(
        response_url,
        {
          response_type: 'ephemeral',
          replace_original: payload.replace_original ?? true,
          ...(payload.text ? { text: payload.text } : {}),
          ...(payload.blocks ? { blocks: payload.blocks } : {}),
        },
        { label: 'final' }
      );
    },
    async error(text, blocks) {
      await sendDelayedResponse(
        response_url,
        {
          response_type: 'ephemeral',
          replace_original: true,
          text: shrinkMrkdwn(text),
          ...(blocks ? { blocks } : {}),
        },
        { label: 'error' }
      );
    },
  };
}

function makeDMResponder(user_id: string): Responder {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN が未設定です（モーダル経由の DM 応答に必須）');
  const client = new WebClient(token);

  return {
    async progress(text) {
      try {
        await client.chat.postMessage({ channel: user_id, text: shrinkMrkdwn(text, 10_000) });
      } catch (e) {
        console.error('[DM] progress', e);
      }
    },
    async final(payload) {
      await client.chat.postMessage({
        channel: user_id,
        text: payload.text ?? 'Xブックマーク推薦',
        ...(payload.blocks ? { blocks: payload.blocks as any } : {}),
      });
    },
    async error(text, blocks) {
      await client.chat.postMessage({
        channel: user_id,
        text: shrinkMrkdwn(text),
        ...(blocks ? { blocks: blocks as any } : {}),
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* モーダルを開く                                                              */
/* -------------------------------------------------------------------------- */

async function openBookmarkModal(triggerId: string, initialText: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN が未設定です（モーダル表示に必須）');
  const client = new WebClient(token);

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'bookmark_modal',
      title: { type: 'plain_text', text: 'Grok推薦' },
      submit: { type: 'plain_text', text: '推薦する' },
      close: { type: 'plain_text', text: 'キャンセル' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '要件や質問を貼り付けてください（長文OK）。結果は *DM* に届きます。\n' +
              '_※ Slack スラッシュコマンドは約4000文字が上限のため、長文はこのモーダルを使ってください_',
          },
        },
        {
          type: 'input',
          block_id: 'query_block',
          label: { type: 'plain_text', text: '要件・質問' },
          element: {
            type: 'plain_text_input',
            action_id: 'query_input',
            multiline: true,
            initial_value: initialText.slice(0, 3000) || undefined,
            placeholder: {
              type: 'plain_text',
              text: '例: チャットアプリにAIエージェントを埋め込む手法を調べたい',
            },
          },
        },
      ],
    },
  });
}

/* -------------------------------------------------------------------------- */
/* コア処理：クエリに対する X → Grok → Slack 表示                               */
/* -------------------------------------------------------------------------- */

async function runBookmarkFlow(
  query: string,
  user_id: string,
  responder: Responder,
  log: DebugLogger
): Promise<void> {
  const { storage } = await import('./storage.js');
  const { createAuthUrl } = await import('./oauth.js');

  const tokens = await storage.getUserTokens(user_id);
  await log.info('tokens fetched', { hasTokens: !!tokens, hasRefresh: !!tokens?.xRefreshToken }, 'proc');

  if (!tokens) {
    const authUrl = await createAuthUrl(user_id);
    await responder.final({
      replace_original: true,
      text: 'Xログインが必要です',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*X Bookmark Grok Recommender* 🚀\n\n初回利用時はXログインが必要です。',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Xでログイン 🔐', emoji: true },
              style: 'primary',
              url: authUrl,
            },
          ],
        },
      ],
    });
    return;
  }

  const grokModel = process.env.GROK_MODEL || 'grok-4.20-reasoning';

  await responder.progress(
    `🔍 *ステップ1/3* 準備中\n` +
      `クエリ長: *${query.length}* 文字\n` +
      `X からブックマークを読み込み中です ⏳`
  );

  await log.info('dynamic import: XService+GrokService', undefined, 'bookmark');
  const { XService } = await import('./services/x.js');
  const { GrokService } = await import('./services/grok.js');
  const xService = new XService(tokens.xAccessToken, user_id);

  await log.info('xService.initialize() start', undefined, 'x');
  await withTimeout(
    (async () => {
      await xService.initialize();
    })(),
    45_000,
    'X ユーザー初期化'
  );
  await log.info('xService.initialize() done', undefined, 'x');

  const bookmarks = await withTimeout(
    xService.getAllBookmarks(false, user_id),
    150_000,
    'X ブックマーク取得'
  );
  await log.info('bookmarks fetched', { count: bookmarks.length }, 'x');

  if (bookmarks.length === 0) {
    await responder.final({
      text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
    });
    return;
  }

  const toGrok = Math.min(50, bookmarks.length);
  await responder.progress(
    `🤖 *ステップ2/3* *Grok（xAI）* に依頼送信中\n` +
      `• *X:* ブックマーク *${bookmarks.length}* 件を取得\n` +
      `• *Grok 入力:* クエリ ＋ 要約 *${toGrok}* 件（新しい順・最大50）\n` +
      `• *モデル:* \`${grokModel}\`\n` +
      `• *今:* Grok API で *推論* 中。60秒経つと再通知します ⬇`
  );

  const grok = new GrokService();

  const longWaitTimer = setTimeout(() => {
    void responder
      .progress(
        `⏳ *Grok 応答待ち*（60秒経過）\n` +
          `*${grokModel}* の JSON 待ち。最大約2分30秒でタイムアウトします。`
      )
      .catch((e) => console.error('[Slack] 60s progress', e));
  }, 60_000);

  let recommendations: Recommendation[];
  try {
    await log.info('Grok rankBookmarks start', { model: grokModel, input_count: bookmarks.length, query_len: query.length }, 'grok');
    recommendations = await withTimeout(grok.rankBookmarks(query, bookmarks), 150_000, 'Grok 分析');
    await log.info('Grok rankBookmarks done', { recs: recommendations.length }, 'grok');
  } catch (e) {
    await log.error('Grok rankBookmarks failed', e, 'grok');
    throw e;
  } finally {
    clearTimeout(longWaitTimer);
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📚 ステップ3/3 完了：Grok推薦', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: shrinkMrkdwn(
          `*Grok*（\`${grokModel}\`）*クエリ長:* ${query.length}文字\n` +
            `*入力ブックマーク* ${bookmarks.length}件 → *表示* 上位${recommendations.length}件`
        ),
      },
    },
    { type: 'divider' },
  ];

  recommendations.forEach((rec, i) => {
    const b = rec.bookmark;
    const color = rec.score >= 85 ? '🟢' : rec.score >= 70 ? '🟡' : '🔴';
    const excerpt = b.text.length > 180 ? b.text.substring(0, 177) + '...' : b.text;
    const reasonShort = shrinkMrkdwn(rec.reason, 400);

    blocks.push(
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: shrinkMrkdwn(
            `*${color} ${rec.score}%* — ${b.authorName} (@${b.authorUsername})\n` +
              `${new Date(b.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}`
          ),
        },
      },
      { type: 'section', text: { type: 'mrkdwn', text: shrinkMrkdwn(`> ${excerpt}`) } }
    );

    if (b.media && b.media.length > 0) {
      const m = b.media[0];
      if (m.previewUrl || m.url) {
        blocks.push({ type: 'image', image_url: m.previewUrl || m.url, alt_text: 'メディア' });
      }
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: shrinkMrkdwn(`📊 関連度 ${rec.score}% ｜ ${reasonShort}`) }],
    });
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Xで開く 🔗', emoji: true },
          url: b.url,
          style: 'primary',
        },
      ],
    });
    if (i < recommendations.length - 1) blocks.push({ type: 'divider' });
  });

  const maxBlocks = 45;
  const finalBlocks = blocks.length > maxBlocks ? blocks.slice(0, maxBlocks) : blocks;

  const textFallback = recommendations
    .map(
      (r, idx) =>
        `${idx + 1}. *${r.score}点* @${r.bookmark.authorUsername} — ${shrinkMrkdwn(r.reason, 200)}\n${r.bookmark.url}`
    )
    .join('\n\n');

  try {
    await log.info('sending final blocks', { blocks: finalBlocks.length }, 'result');
    await responder.final({ blocks: finalBlocks, text: 'Xブックマーク推薦結果' });
    await log.info('final blocks delivered', undefined, 'result');
  } catch (e) {
    await log.error('Block Kit failed, text fallback', e, 'result');
    await responder.final({
      text: shrinkMrkdwn(
        `📚 *Grok 推薦*（クエリ ${query.length}文字）\n\n${textFallback}\n\n_Blocks 送信失敗のため箇条書き表示しています_`
      ),
    });
  }
}

/* -------------------------------------------------------------------------- */
/* X 認証エラー → 再ログインボタン                                              */
/* -------------------------------------------------------------------------- */

async function sendAuthErrorIfNeeded(
  message: string,
  user_id: string,
  responder: Responder
): Promise<boolean> {
  const looksLikeXAuthExpired =
    /401|Unauthorized|Xの認証が期限切れ|Invalid or expired token/i.test(message);
  if (!looksLikeXAuthExpired) return false;

  try {
    const { createAuthUrl } = await import('./oauth.js');
    const authUrl = await createAuthUrl(user_id);
    await responder.error('Xの認証が期限切れです。再ログインしてください。', [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            '⚠️ *Xの認証が期限切れ/無効* になりました。\n' +
            'X OAuth 2.0 のアクセストークンは約2時間で失効します。下のボタンから再ログインしてください。',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Xで再ログイン 🔐', emoji: true },
            style: 'primary',
            url: authUrl,
          },
        ],
      },
      {
        type: 'context',
        elements: [{ type: 'mrkdwn', text: `元のエラー: \`${shrinkMrkdwn(message, 400)}\`` }],
      },
    ]);
    return true;
  } catch (e) {
    console.error('[processCommand] 再ログインブロック送信失敗', e);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* スラッシュコマンドエントリ                                                   */
/* -------------------------------------------------------------------------- */

export async function processSlackCommand(
  params: Record<string, string>,
  reqId?: string
): Promise<void> {
  const { command, text, user_id, response_url, trigger_id, channel_id } = params;
  const log = new DebugLogger(reqId ?? newReqId('proc'));
  await log.info('processSlackCommand start', { command, user_id, text_len: (text || '').length }, 'proc');

  // /bookmark without args (or just '?'): open modal for long-text input
  const trimmed = (text || '').trim();
  if (command === '/bookmark' && (trimmed === '' || trimmed === '?')) {
    try {
      if (!trigger_id) throw new Error('trigger_id が欠落');
      await openBookmarkModal(trigger_id, '');
      await log.info('modal opened', undefined, 'modal');
      // Slack: slash の return は省略で OK（views.open が UI 側）
      return;
    } catch (e) {
      await log.error('openBookmarkModal failed', e, 'modal');
      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        text: `❌ モーダルを開けませんでした: ${e instanceof Error ? e.message : String(e)}\n直接 \`/bookmark 要件…\` と入力してください。`,
      });
      return;
    }
  }

  const responder = makeSlashResponder(channel_id, user_id, response_url);

  try {
    if (command === '/bookmark-sync') {
      await responder.progress('🔄 ブックマークを同期中...（最大800件、数秒かかります）');
      const { storage } = await import('./storage.js');
      const tokens = await storage.getUserTokens(user_id);
      if (!tokens) {
        const { createAuthUrl } = await import('./oauth.js');
        const authUrl = await createAuthUrl(user_id);
        await responder.final({
          text: 'Xログインが必要です',
          blocks: [
            {
              type: 'section',
              text: { type: 'mrkdwn', text: '初回利用時は X ログインが必要です。' },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Xでログイン 🔐', emoji: true },
                  style: 'primary',
                  url: authUrl,
                },
              ],
            },
          ],
        });
        return;
      }
      const { XService } = await import('./services/x.js');
      const xService = new XService(tokens.xAccessToken, user_id);
      await xService.initialize();
      const bookmarks = await xService.getAllBookmarks(true, user_id);
      await responder.final({
        text: `✅ 同期完了！ *${bookmarks.length}件* のブックマークをキャッシュしました。`,
      });
      return;
    }

    if (command === '/bookmark') {
      await runBookmarkFlow(trimmed, user_id, responder, log);
      return;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await log.error('processSlackCommand failed', error, 'proc');
    const handled = await sendAuthErrorIfNeeded(message, user_id, responder);
    if (handled) return;
    try {
      await responder.error(
        `❌ エラー: ${message}\n\n*よくある原因:* ・Xの認証期限切れ ・Grok クレジット残高 / X API プラン ・重い \`/bookmark\`（クエリ短縮、先に \`/bookmark-sync\`）`
      );
    } catch (e) {
      console.error('[processCommand] 最終エラー送信失敗', e);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* インタラクティブ（モーダル送信）エントリ                                     */
/* -------------------------------------------------------------------------- */

export async function processSlackInteractivity(payloadStr: string, reqId?: string): Promise<void> {
  const log = new DebugLogger(reqId ?? newReqId('modal'));
  await log.info('processSlackInteractivity start', { len: payloadStr.length }, 'modal');

  let payload: any;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    await log.error('payload JSON parse failed', e, 'modal');
    return;
  }

  const type: string | undefined = payload?.type;
  await log.info('payload parsed', { type, callback_id: payload?.view?.callback_id }, 'modal');

  if (type !== 'view_submission') {
    await log.info('ignoring non-view_submission', { type }, 'modal');
    return;
  }
  if (payload?.view?.callback_id !== 'bookmark_modal') {
    await log.info('ignoring other callback_id', { cb: payload?.view?.callback_id }, 'modal');
    return;
  }

  const user_id: string = payload.user?.id;
  const query: string =
    payload.view?.state?.values?.query_block?.query_input?.value?.toString().trim() || '';

  await log.info('modal submitted', { user_id, text_len: query.length }, 'modal');

  const responder = makeDMResponder(user_id);

  if (!query) {
    await responder.error('❌ 要件が空でした。もう一度 `/bookmark` からお試しください。');
    return;
  }

  try {
    await responder.progress(
      `📥 受け付けました（${query.length}文字）\n結果はこのDMに届きます。しばらくお待ちください…`
    );
    await runBookmarkFlow(query, user_id, responder, log);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await log.error('modal flow failed', error, 'modal');
    const handled = await sendAuthErrorIfNeeded(message, user_id, responder);
    if (handled) return;
    try {
      await responder.error(
        `❌ エラー: ${message}\n\n*よくある原因:* ・Xの認証期限切れ ・Grok クレジット残高 / X API プラン`
      );
    } catch (e) {
      console.error('[modal] 最終エラー送信失敗', e);
    }
  }
}
