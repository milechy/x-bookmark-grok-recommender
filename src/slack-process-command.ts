/**
 * Slash コマンド / インタラクティブ / Events API の実処理。Node ランタイム向け。
 */
import { WebClient } from '@slack/web-api';
import type { Recommendation, UserTokens, BookmarkCache } from './types.js';
import { DebugLogger, newReqId } from './debug-log.js';

const MAX_SECTION_TEXT = 2800;
function shrinkMrkdwn(s: string, max: number = MAX_SECTION_TEXT): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function fmtDateJst(iso: string | number | undefined): string {
  if (!iso) return '-';
  try {
    const d = typeof iso === 'number' ? new Date(iso) : new Date(iso);
    return d.toLocaleString('ja-JP', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'Asia/Tokyo',
    });
  } catch {
    return '-';
  }
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
/* Responder 抽象：スラッシュ と DM(モーダル) の両方から同じフローを呼べるように。 */
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
/* モーダル: 要件入力                                                          */
/* -------------------------------------------------------------------------- */

async function openBookmarkModal(
  triggerId: string,
  opts: { initialText?: string; defaultForceSync?: boolean } = {}
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN が未設定です（モーダル表示に必須）');
  const client = new WebClient(token);

  const forceSyncOption = {
    text: {
      type: 'plain_text' as const,
      text: 'ブックマークを再取得する（キャッシュを使わない）',
    },
    description: {
      type: 'plain_text' as const,
      text: '遅くなるが最新のブックマークを反映',
    },
    value: 'force_sync',
  };

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
            initial_value: opts.initialText?.slice(0, 3000) || undefined,
            placeholder: {
              type: 'plain_text',
              text: '例: チャットアプリにAIエージェントを埋め込む手法を調べたい',
            },
          },
        },
        {
          type: 'input',
          block_id: 'options_block',
          optional: true,
          label: { type: 'plain_text', text: 'オプション' },
          element: {
            type: 'checkboxes',
            action_id: 'options_input',
            options: [forceSyncOption],
            ...(opts.defaultForceSync ? { initial_options: [forceSyncOption] } : {}),
          },
        },
      ],
    },
  });
}

/** 推薦結果から「もっとこういう視点で」を開くためのリファイン用モーダル */
async function openRefineModal(
  triggerId: string,
  originalQuery: string
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error('SLACK_BOT_TOKEN が未設定です');
  const client = new WebClient(token);

  // Slack の private_metadata は 3000 文字まで
  const privateMetadata = originalQuery.slice(0, 2800);

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: 'modal',
      callback_id: 'bookmark_refine_modal',
      private_metadata: privateMetadata,
      title: { type: 'plain_text', text: '絞り込み再検索' },
      submit: { type: 'plain_text', text: '再検索' },
      close: { type: 'plain_text', text: 'キャンセル' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*元のクエリ:*\n> ${shrinkMrkdwn(originalQuery, 1200)}`,
          },
        },
        { type: 'divider' },
        {
          type: 'input',
          block_id: 'refine_block',
          label: { type: 'plain_text', text: '追加の視点 / 絞り込みたい条件' },
          element: {
            type: 'plain_text_input',
            action_id: 'refine_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: '例: 実装コード例があるものだけ / 2024年以降 / 初心者向け',
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
  log: DebugLogger,
  options: { forceSync?: boolean } = {}
): Promise<void> {
  const { storage } = await import('./storage.js');
  const { createAuthUrl } = await import('./oauth.js');

  const tokens = await storage.getUserTokens(user_id);
  await log.info(
    'tokens fetched',
    { hasTokens: !!tokens, hasRefresh: !!tokens?.xRefreshToken, forceSync: !!options.forceSync },
    'proc'
  );

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

  // Fire-and-forget: トークン古いなら予告 DM
  void maybeWarnStaleAuth(user_id, tokens, log).catch((e) =>
    console.error('[maybeWarnStaleAuth]', e)
  );

  const grokModel = process.env.GROK_MODEL || 'grok-4.20-reasoning';

  await responder.progress(
    `🔍 *ステップ1/3* 準備中\n` +
      `クエリ長: *${query.length}* 文字${options.forceSync ? '（ブックマーク再取得）' : ''}\n` +
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
    xService.getAllBookmarks(!!options.forceSync, user_id),
    150_000,
    'X ブックマーク取得'
  );
  await log.info('bookmarks fetched', { count: bookmarks.length, forceSync: !!options.forceSync }, 'x');

  if (bookmarks.length === 0) {
    await responder.final({
      text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
    });
    return;
  }

  const toGrok = Math.min(50, bookmarks.length);
  await responder.progress(
    `🤖 *ステップ2/3* *Grok（xAI）* に依頼送信中\n` +
      `• *X:* ブックマーク *${bookmarks.length}* 件を取得${options.forceSync ? '（再同期）' : ''}\n` +
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
    await log.info(
      'Grok rankBookmarks start',
      { model: grokModel, input_count: bookmarks.length, query_len: query.length },
      'grok'
    );
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

  // 最後に「もっとこういう視点で絞り込む」アクションを追加
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'actions',
    block_id: 'refine_actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '🔁 もっとこういう視点で絞り込む', emoji: true },
        action_id: 'refine_query',
        // 元クエリを保持（Slack action value は 2000 文字まで）
        value: query.slice(0, 1900),
      },
    ],
  });

  const maxBlocks = 50;
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
/* X 認証 古トークン予告                                                       */
/* -------------------------------------------------------------------------- */

async function maybeWarnStaleAuth(
  user_id: string,
  tokens: UserTokens,
  log: DebugLogger
): Promise<void> {
  try {
    const { kv } = await import('@vercel/kv');
    const createdMs = tokens.createdAt ? new Date(tokens.createdAt).getTime() : 0;
    const ageDays = (Date.now() - createdMs) / (1000 * 60 * 60 * 24);
    if (!Number.isFinite(ageDays) || ageDays < 30) return;

    const key = `authwarn:${user_id}`;
    const last = await kv.get(key);
    if (last) {
      await log.info('authwarn already sent today', { ageDays: Math.round(ageDays) }, 'authwarn');
      return;
    }

    // 24h TTL
    await kv.set(key, 1, { ex: 60 * 60 * 24 });

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) return;
    const client = new WebClient(token);

    const { createAuthUrl } = await import('./oauth.js');
    const authUrl = await createAuthUrl(user_id);

    await client.chat.postMessage({
      channel: user_id,
      text: 'X認証トークンが古くなっています。再ログインを検討してください。',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `🔐 *X認証リフレッシュのおすすめ*\n` +
              `発行から *${Math.floor(ageDays)}日* 経過しています（${fmtDateJst(tokens.createdAt)} 発行）。\n` +
              `自動更新は継続していますが、refresh_token の失効に備えて再ログインしておくと安心です。`,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: '🔐 X再ログイン', emoji: true },
              url: authUrl,
              style: 'primary',
            },
          ],
        },
      ],
    });
    await log.info('authwarn sent', { ageDays: Math.round(ageDays) }, 'authwarn');
  } catch (e) {
    await log.warn('maybeWarnStaleAuth failed', e, 'authwarn');
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
/* App Home タブ                                                              */
/* -------------------------------------------------------------------------- */

async function publishHomeView(user_id: string, log: DebugLogger): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    await log.warn('publishHomeView skipped (SLACK_BOT_TOKEN unset)', undefined, 'home');
    return;
  }
  const client = new WebClient(token);
  const { storage } = await import('./storage.js');
  const { createAuthUrl } = await import('./oauth.js');

  let tokens: UserTokens | null = null;
  let cache: BookmarkCache | null = null;
  try {
    tokens = await storage.getUserTokens(user_id);
    cache = await storage.getBookmarkCache(user_id);
  } catch (e) {
    await log.warn('home data fetch failed', e, 'home');
  }

  const grokModel = process.env.GROK_MODEL || 'grok-4.20-reasoning';
  const allowKwFb = process.env.GROK_ALLOW_KEYWORD_FALLBACK === '1';
  const authUrl = await createAuthUrl(user_id);

  const ageDays = tokens?.createdAt
    ? Math.floor((Date.now() - new Date(tokens.createdAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  const authText = tokens
    ? `✅ *X アカウント連携済み*\n発行: ${fmtDateJst(tokens.createdAt)}${
        ageDays !== null ? `（${ageDays}日前）` : ''
      }\nリフレッシュトークン: ${tokens.xRefreshToken ? 'あり ✅' : 'なし ⚠️'}`
    : '⚠️ *X アカウント未連携*\n下のボタンからログインしてください。';

  const cacheText = cache
    ? `📚 ブックマーク *${cache.bookmarks.length}* 件キャッシュ済み\n最終同期: ${fmtDateJst(cache.lastSynced)}`
    : '📚 キャッシュなし（`/bookmark-sync` または `/bookmark` で初回取得）';

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🔖 X Bookmark Grok Recommender', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: authText },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: tokens ? '🔐 X再ログイン' : '🔐 Xでログイン',
            emoji: true,
          },
          url: authUrl,
          ...(tokens ? {} : { style: 'primary' as const }),
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: cacheText },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `⚙️ *設定*\n` +
          `• Grok モデル: \`${grokModel}\`\n` +
          `• キーワード fallback: ${allowKwFb ? 'ON（Grok 失敗時に代替）' : 'OFF（厳密）'}\n` +
          `• X Client ID: ${process.env.X_CLIENT_ID ? '設定済み ✅' : '未設定 ⚠️'}`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          '*📘 使い方*\n' +
          '• `/bookmark <短文>` — その場で Grok 推薦（チャンネル内 ephemeral）\n' +
          '• `/bookmark` — モーダルで長文貼り付け → 結果は *DM* に\n' +
          '• `/bookmark-sync` — ブックマークキャッシュを強制再取得\n' +
          '• 推薦結果下部の *「🔁 もっとこういう視点で絞り込む」* で追加の観点を足して再検索可',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `更新: ${fmtDateJst(new Date().toISOString())} ｜ reqId: \`${log.reqId}\``,
        },
      ],
    },
  ];

  await client.views.publish({
    user_id,
    view: { type: 'home', blocks: blocks as any },
  });
  await log.info('home view published', { hasTokens: !!tokens, cacheCount: cache?.bookmarks.length }, 'home');
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

  const trimmed = (text || '').trim();
  if (command === '/bookmark' && (trimmed === '' || trimmed === '?')) {
    try {
      if (!trigger_id) throw new Error('trigger_id が欠落');
      await openBookmarkModal(trigger_id, {});
      await log.info('modal opened', undefined, 'modal');
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
/* インタラクティブ（モーダル送信 / ボタン）                                    */
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
  await log.info(
    'payload parsed',
    { type, callback_id: payload?.view?.callback_id, action: payload?.actions?.[0]?.action_id },
    'modal'
  );

  /* --- block_actions: ボタン等 --- */
  if (type === 'block_actions') {
    const action = payload.actions?.[0];
    const trigger_id: string | undefined = payload.trigger_id;
    const user_id: string = payload.user?.id;

    if (action?.action_id === 'refine_query' && trigger_id) {
      const original = (action.value || '').toString();
      try {
        await openRefineModal(trigger_id, original);
        await log.info('refine modal opened', { orig_len: original.length }, 'modal');
      } catch (e) {
        await log.error('refine modal open failed', e, 'modal');
        try {
          const responder = makeDMResponder(user_id);
          await responder.error('❌ 絞り込みモーダルを開けませんでした。`/bookmark` から再度お試しください。');
        } catch (e2) {
          console.error('[refine] DM fallback', e2);
        }
      }
      return;
    }

    await log.info('ignored block_actions', { action_id: action?.action_id }, 'modal');
    return;
  }

  /* --- view_submission --- */
  if (type !== 'view_submission') {
    await log.info('ignoring non-view_submission', { type }, 'modal');
    return;
  }

  const callback_id: string = payload?.view?.callback_id;
  const user_id: string = payload.user?.id;

  if (callback_id === 'bookmark_modal') {
    const query: string =
      payload.view?.state?.values?.query_block?.query_input?.value?.toString().trim() || '';
    const selected =
      payload.view?.state?.values?.options_block?.options_input?.selected_options ?? [];
    const forceSync = Array.isArray(selected) && selected.some((o: any) => o?.value === 'force_sync');

    await log.info(
      'bookmark_modal submitted',
      { user_id, text_len: query.length, forceSync },
      'modal'
    );

    const responder = makeDMResponder(user_id);
    if (!query) {
      await responder.error('❌ 要件が空でした。もう一度 `/bookmark` からお試しください。');
      return;
    }
    try {
      await responder.progress(
        `📥 受け付けました（${query.length}文字${forceSync ? ' / 再取得' : ''}）\n` +
          `結果はこのDMに届きます。しばらくお待ちください…`
      );
      await runBookmarkFlow(query, user_id, responder, log, { forceSync });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await log.error('bookmark_modal flow failed', error, 'modal');
      const handled = await sendAuthErrorIfNeeded(message, user_id, responder);
      if (handled) return;
      try {
        await responder.error(`❌ エラー: ${message}`);
      } catch (e) {
        console.error('[modal] 最終エラー送信失敗', e);
      }
    }
    return;
  }

  if (callback_id === 'bookmark_refine_modal') {
    const original = (payload.view?.private_metadata || '').toString();
    const addition =
      payload.view?.state?.values?.refine_block?.refine_input?.value?.toString().trim() || '';

    const combined = original
      ? `${original}\n\n# 追加の視点・絞り込み\n${addition}`
      : addition;

    await log.info(
      'refine_modal submitted',
      { user_id, orig_len: original.length, add_len: addition.length, combined_len: combined.length },
      'modal'
    );

    const responder = makeDMResponder(user_id);
    if (!combined) {
      await responder.error('❌ 絞り込み条件が空でした。');
      return;
    }
    try {
      await responder.progress(
        `🔁 絞り込み再検索を開始します（合計 ${combined.length}文字）。\n` +
          `追加視点: *${shrinkMrkdwn(addition, 300)}*\n結果はこの DM に届きます。`
      );
      await runBookmarkFlow(combined, user_id, responder, log);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await log.error('refine_modal flow failed', error, 'modal');
      const handled = await sendAuthErrorIfNeeded(message, user_id, responder);
      if (handled) return;
      try {
        await responder.error(`❌ エラー: ${message}`);
      } catch (e) {
        console.error('[refine] 最終エラー送信失敗', e);
      }
    }
    return;
  }

  await log.info('ignoring other callback_id', { cb: callback_id }, 'modal');
}

/* -------------------------------------------------------------------------- */
/* Events API (app_home_opened 等)                                             */
/* -------------------------------------------------------------------------- */

export async function processSlackEvent(event: any, reqId?: string): Promise<void> {
  const log = new DebugLogger(reqId ?? newReqId('event'));
  await log.info('processSlackEvent', { type: event?.type, tab: event?.tab }, 'event');

  if (!event || typeof event !== 'object') return;

  if (event.type === 'app_home_opened' && (event.tab === 'home' || !event.tab)) {
    const user_id: string | undefined = event.user;
    if (!user_id) return;
    try {
      await publishHomeView(user_id, log);
    } catch (e) {
      await log.error('publishHomeView failed', e, 'home');
    }
    return;
  }

  // 他のイベントは未対応
}
