/**
 * Slash コマンドの実処理（X / Grok）。Node ランタイム向け。
 * Edge の手前で即 ACK するため、api/slack-background から呼び出す。
 */
import { WebClient } from '@slack/web-api';
import type { Recommendation } from './types.js';
import { DebugLogger, newReqId } from './debug-log.js';

// Slack: mrkdwn はおおよそ 1 万文字制限。section text は安全のため切り詰め
const MAX_SECTION_TEXT = 2800;
function shrinkMrkdwn(s: string, max: number = MAX_SECTION_TEXT): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

// Send delayed response via response_url
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
  // Slack: 本文が JSON なら { ok: false, error: "..." } を解釈
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const j = JSON.parse(trimmed) as { ok?: boolean; error?: string };
      if (j && j.ok === false) {
        console.error(`[${label}] Slack ok:false`, j.error, bodyText);
        throw new Error(j.error || 'response_url failed');
      }
    } catch (e) {
      if (e instanceof SyntaxError) {
        // 想定外の JSON
      } else {
        throw e;
      }
    }
  }
  return r;
}

type SlashParams = { channel_id?: string; user_id: string; response_url: string };

/**
 * 進捗は chat.postEphemeral。slash の response_url は最大5回なので、結果表示用の枠を残す。
 */
async function postProgressEphemeral(slash: SlashParams, text: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (token && slash.channel_id) {
    try {
      const client = new WebClient(token);
      const r = await client.chat.postEphemeral({
        channel: slash.channel_id,
        user: slash.user_id,
        text: shrinkMrkdwn(text, 10_000),
      });
      if (r.ok) {
        return;
      }
      console.error('[Slack] postEphemeral not ok', r.error);
    } catch (e) {
      console.error('[Slack] postEphemeral', e);
    }
  }
  await sendDelayedResponse(
    slash.response_url,
    { response_type: 'ephemeral', text: shrinkMrkdwn(text) },
    { label: 'progress-fallback' }
  );
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

export async function processSlackCommand(
  params: Record<string, string>,
  reqId?: string
): Promise<void> {
  const { command, text, user_id, response_url } = params;
  const log = new DebugLogger(reqId ?? newReqId('proc'));
  await log.info('processSlackCommand start', { command, user_id, text_len: (text || '').length }, 'proc');

  try {
    await log.info('dynamic import: storage+oauth', undefined, 'proc');
    const { storage } = await import('./storage.js');
    const { createAuthUrl } = await import('./oauth.js');

    const tokens = await storage.getUserTokens(user_id);
    await log.info('tokens fetched', { hasTokens: !!tokens, hasRefresh: !!tokens?.xRefreshToken }, 'proc');

    if (!tokens) {
      const authUrl = await createAuthUrl(user_id);
      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*X Bookmark Grok Recommender* 🚀\n\n初回利用時はXログインが必要です。下のボタンからXにログインしてください。',
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

    if (command === '/bookmark-sync') {
      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        text: '🔄 ブックマークを同期中...（最大800件、数秒かかります）',
      });

      const { XService } = await import('./services/x.js');
      const xService = new XService(tokens.xAccessToken, user_id);
      await xService.initialize();
      const bookmarks = await xService.getAllBookmarks(true, user_id);

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: `✅ 同期完了！ *${bookmarks.length}件* のブックマークをキャッシュしました。\n\n次に \`/bookmark <要件>\` でGrok推薦をお試しください。`,
      });
      return;
    }

    if (command === '/bookmark') {
      const query = (text || '').trim() || 'おすすめのブックマーク';
      const grokModel = process.env.GROK_MODEL || 'grok-4.20-reasoning';
      const slash: SlashParams = {
        channel_id: params.channel_id,
        user_id,
        response_url,
      };

      await postProgressEphemeral(
        slash,
        `🔍 *ステップ1/3* 準備中\n` +
          `クエリ: \`${shrinkMrkdwn(query, 300)}\`\n` +
          `X からブックマークを読み込み中です（進捗はこの下に追記されます）⏳`
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
        'X ユーザー初期化',
      );
      await log.info('xService.initialize() done', undefined, 'x');
      const bookmarks = await withTimeout(
        xService.getAllBookmarks(false, user_id),
        150_000,
        'X ブックマーク取得',
      );
      await log.info('bookmarks fetched', { count: bookmarks.length }, 'x');

      if (bookmarks.length === 0) {
        await sendDelayedResponse(response_url, {
          response_type: 'ephemeral',
          replace_original: true,
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
        });
        return;
      }

      const toGrok = Math.min(50, bookmarks.length);
      await postProgressEphemeral(
        slash,
        `🤖 *ステップ2/3* *Grok（xAI）* に依頼送信中\n` +
          `• *X:* ブックマーク *${bookmarks.length}* 件を取得済み\n` +
          `• *Grok 入力:* クエリ ＋ 要約 *${toGrok}* 件（新しい順・最大50）\n` +
          `• *モデル:* \`${grokModel}\`\n` +
          `• *今:* Grok API で *推論* 中。60秒経つと下にもう1行出ます⬇`
      );

      const grok = new GrokService();

      let longWaitTimer: ReturnType<typeof setTimeout> | undefined;
      longWaitTimer = setTimeout(() => {
        void postProgressEphemeral(
          slash,
          `⏳ *Grok 応答待ち*（60秒経過）\n` +
            `*${grokModel}* の JSON 待ち。推論に時間がかかる場合があります。最大約2分30秒でタイムアウト。`
        ).catch((e) => console.error('[Slack] 60s progress', e));
      }, 60_000);

      let recommendations: Recommendation[];
      try {
        await log.info('Grok rankBookmarks start', { model: grokModel, input_count: bookmarks.length }, 'grok');
        recommendations = await withTimeout(
          grok.rankBookmarks(query, bookmarks),
          150_000,
          'Grok 分析',
        );
        await log.info('Grok rankBookmarks done', { recs: recommendations.length }, 'grok');
      } catch (e) {
        await log.error('Grok rankBookmarks failed', e, 'grok');
        throw e;
      } finally {
        if (longWaitTimer !== undefined) {
          clearTimeout(longWaitTimer);
        }
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
              `*Grok*（\`${grokModel}\`）*クエリ:* \`${shrinkMrkdwn(query, 500)}\`\n*入力ブックマーク* ${bookmarks.length}件 → *表示* 上位${recommendations.length}件`
            ),
          },
        },
        { type: 'divider' },
      ];

      recommendations.forEach((rec: Recommendation, i: number) => {
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
            blocks.push({
              type: 'image',
              image_url: m.previewUrl || m.url,
              alt_text: 'メディア',
            });
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

      // Block Kit 上限（約50ブロック）超過を避けて削る
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
        await sendDelayedResponse(
          response_url,
          {
            response_type: 'ephemeral',
            replace_original: true,
            blocks: finalBlocks,
            text: 'Xブックマーク推薦結果',
          },
          { label: 'blocks' }
        );
        await log.info('final blocks delivered', undefined, 'result');
      } catch (e) {
        await log.error('Block Kit failed, text fallback', e, 'result');
        await sendDelayedResponse(
          response_url,
          {
            response_type: 'ephemeral',
            replace_original: true,
            text: shrinkMrkdwn(
              `📚 *Grok 推薦*（\`${shrinkMrkdwn(query, 200)}\`）\n\n${textFallback}\n\n_Blocks 送信失敗のため箇条書き表示しています_`
            ),
          },
          { label: 'text-fallback' }
        );
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await log.error('processSlackCommand failed', error, 'proc');
    const ru = params.response_url;
    if (!ru) return;

    const looksLikeXAuthExpired =
      /401|Unauthorized|Xの認証が期限切れ|Invalid or expired token/i.test(message);

    if (looksLikeXAuthExpired) {
      try {
        const { createAuthUrl } = await import('./oauth.js');
        const authUrl = await createAuthUrl(params.user_id);
        await sendDelayedResponse(
          ru,
          {
            response_type: 'ephemeral',
            replace_original: true,
            blocks: [
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
                elements: [
                  { type: 'mrkdwn', text: `元のエラー: \`${shrinkMrkdwn(message, 400)}\`` },
                ],
              },
            ],
            text: 'Xの認証が期限切れです。再ログインしてください。',
          },
          { label: 'x-reauth' }
        );
        return;
      } catch (e) {
        console.error('[processCommand] 再ログインブロック送信失敗', e);
      }
    }

    try {
      await sendDelayedResponse(ru, {
        response_type: 'ephemeral',
        replace_original: true,
        text: shrinkMrkdwn(
          `❌ エラー: ${message}\n\n*よくある原因:* ・Xの認証期限切れ（/bookmark から再ログイン） ・Grok クレジット残高 / X API プラン ・重い \`/bookmark\`（クエリ短縮、先に \`/bookmark-sync\`）`
        ),
      });
    } catch (e) {
      console.error('[processCommand] response_url 失敗', e);
    }
  }
}
