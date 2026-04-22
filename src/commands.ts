import { App } from '@slack/bolt';
import { XService } from './services/x.js';
import GrokService from './services/grok.js';
import { sendXLoginDM } from './oauth.js';
import { storage } from './storage.js';

const grokService = new GrokService();

export function registerCommands(app: App) {
  // Slash command: /bookmark <要件>
  app.command('/bookmark', async ({ command, ack, respond, client }) => {
    // ack() must be called within 3 seconds - do it FIRST
    await ack();

    const query = command.text.trim() || 'おすすめのブックマークを教えて';
    const slackUserId = command.user_id;

    try {
      const tokens = await storage.getUserTokens(slackUserId);
      if (!tokens) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ Xアカウントの認証が必要です。DMを確認してください。',
        });
        await sendXLoginDM(client, slackUserId);
        return;
      }

      // Immediate progress message so user knows it's working
      await respond({
        response_type: 'ephemeral',
        text: `🔍 「${query}」で検索中... ブックマークを取得してGrokで分析しています。少々お待ちください⏳`,
      });

      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();

      const bookmarks = await xService.getAllBookmarks(false, slackUserId);

      if (bookmarks.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからもう一度お試しください。',
        });
        return;
      }

      const recommendations = await grokService.rankBookmarks(query, bookmarks);

      const blocks: any[] = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: '📚 Xブックマーク Grok推薦',
            emoji: true,
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*クエリ:* \`${query}\`　*分析:* ${bookmarks.length}件 → 上位8件を推薦`,
          },
        },
        { type: 'divider' },
      ];

      recommendations.forEach((rec, index) => {
        const b = rec.bookmark;
        const scoreColor = rec.score >= 85 ? '🟢' : rec.score >= 70 ? '🟡' : '🔴';
        const excerpt = b.text.length > 180 ? b.text.substring(0, 177) + '...' : b.text;

        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `*${scoreColor} ${rec.score}%* — ${b.authorName} (@${b.authorUsername})\n` +
              `${new Date(b.createdAt).toLocaleDateString('ja-JP', { year: 'numeric', month: 'short', day: 'numeric' })}`,
          },
        });
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `> ${excerpt}`,
          },
        });

        if (b.media && b.media.length > 0 && (b.media[0].previewUrl || b.media[0].url)) {
          blocks.push({
            type: 'image',
            image_url: b.media[0].previewUrl || b.media[0].url,
            alt_text: 'メディアサムネイル',
          });
        }

        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `📊 *関連度:* ${rec.score}% ｜ ${rec.reason}` }],
        });

        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Xで開く 🔗', emoji: true },
              url: b.url,
              action_id: `open_x_${b.id}`,
              style: 'primary',
            },
          ],
        });

        if (index < recommendations.length - 1) {
          blocks.push({ type: 'divider' });
        }
      });

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 より具体的な要件（例: `TypeScript ベストプラクティス`）で精度アップ。`/bookmark-sync` で最新ブックマークを同期。',
          },
        ],
      });

      await respond({
        response_type: 'ephemeral',
        blocks,
        text: 'Xブックマーク推薦結果',
      });

      console.log(`[/bookmark] Done for ${slackUserId}, query="${query}", ${recommendations.length} results`);
    } catch (error: any) {
      console.error('[/bookmark] Error:', error);
      let userMessage = '申し訳ありません。処理中にエラーが発生しました。';
      if (error.message?.includes('token') || error.message?.includes('auth')) {
        userMessage = 'X認証の有効期限が切れている可能性があります。もう一度「Xでログイン」から認証してください。';
        await sendXLoginDM(client, slackUserId);
      } else if (error.message?.includes('rate')) {
        userMessage = 'APIレート制限に達しました。しばらく待ってからもう一度お試しください。';
      }
      await respond({
        response_type: 'ephemeral',
        text: `❌ ${userMessage}\n\n詳細: ${error.message}`,
      });
    }
  });

  // Slash command: /bookmark-sync
  app.command('/bookmark-sync', async ({ command, ack, respond, client }) => {
    // ack() within 3 seconds - immediately
    await ack();

    const slackUserId = command.user_id;

    try {
      const tokens = await storage.getUserTokens(slackUserId);
      if (!tokens) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ まず `/bookmark` を実行してXログインを完了してください。',
        });
        await sendXLoginDM(client, slackUserId);
        return;
      }

      // Immediate response before heavy operation
      await respond({
        response_type: 'ephemeral',
        text: '🔄 ブックマークを強制同期中...（最大800件まで取得します）少々お待ちください⏳',
      });

      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();

      const bookmarks = await xService.getAllBookmarks(true, slackUserId);

      await respond({
        response_type: 'ephemeral',
        text: `✅ 同期完了！ ${bookmarks.length}件のブックマークをキャッシュしました。\n\n次に \`/bookmark <要件>\` でGrok推薦をお試しください。`,
      });

      console.log(`[/bookmark-sync] Done for ${slackUserId}, ${bookmarks.length} bookmarks`);
    } catch (error: any) {
      console.error('[/bookmark-sync] Error:', error);
      await respond({
        response_type: 'ephemeral',
        text: `❌ 同期に失敗しました: ${error.message}\n\nXアプリの権限（bookmark.read）を確認するか、再度ログインしてください。`,
      });
    }
  });

  app.action(/open_x_.*/, async ({ ack }) => {
    await ack();
  });

  console.log('✅ Slack commands registered (Japanese UI)');
}
