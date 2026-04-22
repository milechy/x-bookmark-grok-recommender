import { App } from '@slack/bolt';
import { XService } from './services/x.js';
import GrokService from './services/grok.js';
import { sendXLoginDM } from './oauth.js';
import { storage } from './storage.js';
import type { XBookmark, Recommendation } from './types.js';

const grokService = new GrokService();

export function registerCommands(app: App) {
  // Slash command: /bookmark <要件>
  app.command('/bookmark', async ({ command, ack, respond, client }) => {
    await ack();

    const query = command.text.trim() || 'おすすめのブックマークを教えて';
    const slackUserId = command.user_id;

    try {
      // Check authentication
      const tokens = await storage.getUserTokens(slackUserId);
      if (!tokens) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ Xアカウントの認証が必要です。DMを確認してください。',
        });
        await sendXLoginDM(client, slackUserId);
        return;
      }

      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();

      // Fetch bookmarks (cached by default)
      const bookmarks = await xService.getAllBookmarks(false, slackUserId);

      if (bookmarks.length === 0) {
        await respond({
          response_type: 'ephemeral',
          text: 'ブックマークが見つかりませんでした。Xでブックマークを追加してからもう一度お試しください。',
        });
        return;
      }

      await respond({
        response_type: 'ephemeral',
        text: `🔍 「${query}」で検索中... Grokがおすすめを分析しています（${bookmarks.length}件のブックマークから）`,
      });

      // Get AI recommendations
      const recommendations = await grokService.rankBookmarks(query, bookmarks);

      // Build beautiful Block Kit UI
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
            text: `*クエリ:* \`${query}\`\n*分析対象:* ${bookmarks.length}件のブックマーク\n*上位8件をおすすめします*`,
          },
        },
        {
          type: 'divider',
        },
      ];

      recommendations.forEach((rec, index) => {
        const b = rec.bookmark;
        const scoreColor = rec.score >= 85 ? '🟢' : rec.score >= 70 ? '🟡' : '🔴';
        const excerpt = b.text.length > 180 ? b.text.substring(0, 177) + '...' : b.text;

        const cardBlocks: (Block | KnownBlock)[] = [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*${scoreColor} ${rec.score}%* ${b.authorName} (@${b.authorUsername})\n` +
                    `${new Date(b.createdAt).toLocaleDateString('ja-JP', { 
                      year: 'numeric', month: 'short', day: 'numeric' 
                    })}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `> ${excerpt}`,
            },
          },
        ];

        // Add media thumbnail if available
        if (b.media && b.media.length > 0) {
          const firstMedia = b.media[0];
          cardBlocks.push({
            type: 'image',
            image_url: firstMedia.previewUrl || firstMedia.url,
            alt_text: 'メディアサムネイル',
          });
        }

        cardBlocks.push({
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: `📊 *関連度:* ${rec.score}% | ${rec.reason}`,
            },
          ],
        });

        cardBlocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: {
                type: 'plain_text',
                text: 'Xで開く 🔗',
                emoji: true,
              },
              url: b.url,
              action_id: `open_x_${b.id}`,
              style: 'primary',
            },
          ],
        });

        // Add the card with divider
        blocks.push(...cardBlocks);
        if (index < recommendations.length - 1) {
          blocks.push({ type: 'divider' });
        }
      });

      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💡 *ヒント:* より具体的な要件（例: 「AI スタートアップ」「TypeScript ベストプラクティス」）を指定すると精度が上がります。\n/sync で最新ブックマークを強制同期できます。',
          },
        ],
      });

      await respond({
        response_type: 'ephemeral',
        blocks,
        text: 'Xブックマーク推薦結果',
      });

      console.log(`[Command] /bookmark completed for ${slackUserId} with query "${query}"`);

    } catch (error: any) {
      console.error('[Command] Error:', error);
      
      let userMessage = '申し訳ありません。処理中にエラーが発生しました。';
      
      if (error.message.includes('token') || error.message.includes('auth')) {
        userMessage = 'X認証の有効期限が切れている可能性があります。もう一度「Xでログイン」から認証してください。';
        await sendXLoginDM(client, slackUserId);
      } else if (error.message.includes('rate')) {
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
    await ack();

    const slackUserId = command.user_id;

    try {
      const tokens = await storage.getUserTokens(slackUserId);
      if (!tokens) {
        await respond({
          response_type: 'ephemeral',
          text: '⚠️ まず /bookmark を実行してXログインを完了してください。',
        });
        await sendXLoginDM(client, slackUserId);
        return;
      }

      const xService = new XService(tokens.xAccessToken);
      await xService.initialize();

      await respond({
        response_type: 'ephemeral',
        text: '🔄 ブックマークを強制同期中...（最大800件まで取得します）',
      });

      const bookmarks = await xService.getAllBookmarks(true, slackUserId); // force sync

      await respond({
        response_type: 'ephemeral',
        text: `✅ 同期完了！ ${bookmarks.length}件のブックマークをキャッシュしました。\n\n次に /bookmark <要件> でGrok推薦をお試しください。`,
      });

    } catch (error: any) {
      console.error('[Sync] Error:', error);
      await respond({
        response_type: 'ephemeral',
        text: `❌ 同期に失敗しました: ${error.message}\n\nXアプリの権限（bookmark.read）を確認するか、再度ログインしてください。`,
      });
    }
  });

  // Handle interactivity if needed (e.g. buttons)
  app.action(/open_x_.*/, async ({ action, ack }) => {
    await ack(); // just acknowledge URL buttons don't need more
  });

  console.log('✅ Slack commands registered successfully. Japanese UI ready.');
}
