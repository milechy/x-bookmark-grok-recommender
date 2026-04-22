/**
 * Slash コマンドの実処理（X / Grok）。Node ランタイム向け。
 * Edge の手前で即 ACK するため、api/slack-background から呼び出す。
 */
import type { Recommendation } from './types.js';

// Send delayed response via response_url
export async function sendDelayedResponse(responseUrl: string, payload: unknown): Promise<void> {
  try {
    await fetch(responseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('[response_url] Failed:', err);
  }
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
      await xService.initialize();
      const bookmarks = await xService.getAllBookmarks(false, user_id);

      if (bookmarks.length === 0) {
        await sendDelayedResponse(response_url, {
          response_type: 'ephemeral',
          replace_original: true,
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからお試しください。',
        });
        return;
      }

      const grok = new GrokService();
      const recommendations = await grok.rankBookmarks(query, bookmarks);

      const blocks: unknown[] = [
        {
          type: 'header',
          text: { type: 'plain_text', text: '📚 Xブックマーク Grok推薦', emoji: true },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*クエリ:* \`${query}\`　*分析:* ${bookmarks.length}件 → 上位${recommendations.length}件`,
          },
        },
        { type: 'divider' },
      ];

      recommendations.forEach((rec: Recommendation, i: number) => {
        const b = rec.bookmark;
        const color = rec.score >= 85 ? '🟢' : rec.score >= 70 ? '🟡' : '🔴';
        const excerpt = b.text.length > 180 ? b.text.substring(0, 177) + '...' : b.text;

        blocks.push(
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                `*${color} ${rec.score}%* — ${b.authorName} (@${b.authorUsername})\n` +
                `${new Date(b.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}`,
            },
          },
          { type: 'section', text: { type: 'mrkdwn', text: `> ${excerpt}` } }
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
          elements: [{ type: 'mrkdwn', text: `📊 関連度 ${rec.score}% ｜ ${rec.reason}` }],
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

      await sendDelayedResponse(response_url, {
        response_type: 'ephemeral',
        replace_original: true,
        blocks,
        text: 'Xブックマーク推薦結果',
      });
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[processCommand] Error:', error);
    await sendDelayedResponse(params.response_url, {
      response_type: 'ephemeral',
      replace_original: true,
      text: `❌ エラーが発生しました: ${message}\n\nX認証が切れている場合は再度 \`/bookmark\` を実行してください。`,
    });
  }
}
