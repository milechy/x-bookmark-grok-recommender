/**
 * Slash コマンドの実処理（X / Grok）。Node ランタイム向け。
 * Edge の手前で即 ACK するため、api/slack-background から呼び出す。
 */
import type { Recommendation } from './types.js';

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

export async function processSlackCommand(params: Record<string, string>): Promise<void> {
  const { command, text, user_id, response_url } = params;
  console.log(`[Slack] Processing ${command} for user ${user_id}`);

  try {
    const { storage } = await import('./storage.js');
    const { createAuthUrl } = await import('./oauth.js');

    const tokens = await storage.getUserTokens(user_id);

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
      const xService = new XService(tokens.xAccessToken);
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

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        text: `🔍 「${query}」で分析中... Grokがブックマークからおすすめを選定しています⏳`,
      });

      const { XService } = await import('./services/x.js');
      const { GrokService } = await import('./services/grok.js');
      const xService = new XService(tokens.xAccessToken);
      await withTimeout(
        (async () => {
          await xService.initialize();
        })(),
        45_000,
        'X ユーザー初期化',
      );
      const bookmarks = await withTimeout(
        xService.getAllBookmarks(false, user_id),
        150_000,
        'X ブックマーク取得',
      );

      if (bookmarks.length === 0) {
        await sendDelayedResponse(response_url, {
          response_type: 'ephemeral',
          replace_original: true,
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
        });
        return;
      }

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        text: `⏱ ${bookmarks.length}件のブックマークを読みました。Grok 分析中…（目安1〜2分。長いとタイムアウトの場合はクエリを短くしてください）`,
      });

      const grok = new GrokService();
      const recommendations = await withTimeout(
        grok.rankBookmarks(query, bookmarks),
        150_000,
        'Grok 分析',
      );

      const blocks: unknown[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📚 Xブックマーク Grok推薦', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: shrinkMrkdwn(
              `*クエリ:* \`${shrinkMrkdwn(query, 500)}\`　*分析:* ${bookmarks.length}件 → 上位${recommendations.length}件`
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
      } catch (e) {
        console.error('[Slack] Block Kit 失敗。テキストのみ再送', e);
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
    console.error('[processCommand] Error:', error);
    const ru = params.response_url;
    if (ru) {
      try {
        await sendDelayedResponse(ru, {
          response_type: 'ephemeral',
          replace_original: true,
          text: shrinkMrkdwn(
            `❌ エラー: ${message}\n\n*よくある原因:* ・Grok クレジット残高 / X API プラン ・重い \`/bookmark\`（クエリ短縮、先に \`/bookmark-sync\`）`
          ),
        });
      } catch (e) {
        console.error('[processCommand] response_url 失敗', e);
      }
    }
  }
}
