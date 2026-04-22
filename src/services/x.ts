import { TwitterApi } from 'twitter-api-v2';
import { XBookmark } from '../types.js';
import { storage } from '../storage.js';
import { refreshXAccessToken } from '../oauth.js';

/** X API 呼び出しエラーが 401（= access_token 期限切れ/無効）か判定 */
function isXUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; data?: { status?: number; title?: string } };
  if (e.code === 401) return true;
  if (e.data?.status === 401) return true;
  const msg = err instanceof Error ? err.message : '';
  return /401|Unauthorized|Invalid or expired token/i.test(msg);
}

export class XService {
  private client: TwitterApi | null = null;
  private userId = '';
  private slackUserId: string | undefined;

  constructor(accessToken: string, slackUserId?: string) {
    this.client = new TwitterApi(accessToken);
    this.slackUserId = slackUserId;
  }

  /**
   * Slack ユーザーの X トークンを更新し、クライアントを差し替え。失敗したら null。
   */
  private async tryRefresh(): Promise<boolean> {
    if (!this.slackUserId) return false;
    const newToken = await refreshXAccessToken(this.slackUserId);
    if (!newToken) return false;
    this.client = new TwitterApi(newToken);
    console.log('[X] Access token refreshed and client replaced');
    return true;
  }

  /**
   * 401 なら1度だけ refresh して再試行。それでも 401 なら、再ログインを促す明示エラーへ置換。
   */
  private async withAuthRetry<T>(op: () => Promise<T>, opName: string): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (!isXUnauthorized(err)) throw err;

      console.warn(`[X] ${opName}: 401, trying token refresh…`);
      const refreshed = await this.tryRefresh();
      if (!refreshed) {
        throw new Error(
          'Xの認証が期限切れです。もう一度 `/bookmark` から「Xでログイン」してください（リフレッシュトークン不在または失効）。'
        );
      }
      try {
        return await op();
      } catch (err2) {
        if (isXUnauthorized(err2)) {
          throw new Error(
            'Xの認証が期限切れです。もう一度 `/bookmark` から「Xでログイン」してください。'
          );
        }
        throw err2;
      }
    }
  }

  async initialize(): Promise<void> {
    await this.withAuthRetry(async () => {
      const me = await this.client!.v2.me({ 'user.fields': ['username', 'name'] });
      this.userId = me.data.id;
      console.log(`[X] Initialized for user @${me.data.username} (ID: ${this.userId})`);
    }, 'initialize');
  }

  /**
   * Fetch all bookmarks with pagination. Limited to ~800 for performance.
   * Uses cache if recent, else fresh fetch.
   */
  async getAllBookmarks(forceSync = false, slackUserId?: string): Promise<XBookmark[]> {
    if (slackUserId && !this.slackUserId) {
      this.slackUserId = slackUserId;
    }

    if (slackUserId) {
      const cached = await storage.getBookmarkCache(slackUserId);
      if (!forceSync && cached && cached.bookmarks.length > 0) {
        const lastSync = new Date(cached.lastSynced);
        const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
        if (hoursSinceSync < 24) {
          console.log(
            `[X] Using cached bookmarks (${cached.bookmarks.length} items, synced ${hoursSinceSync.toFixed(1)}h ago)`
          );
          return cached.bookmarks;
        }
      }
    }

    if (!this.client || !this.userId) {
      await this.initialize();
    }

    console.log(`[X] Fetching bookmarks (forceSync: ${forceSync})...`);
    const bookmarks: XBookmark[] = [];
    let paginationToken: string | undefined;

    const MAX_PAGES = 8; // ~800 items max (100 per page)
    let page = 0;

    do {
      page++;
      const queryParams: any = {
        max_results: 100,
        'tweet.fields': 'created_at,author_id,public_metrics,attachments,entities',
        'user.fields': 'name,username,profile_image_url',
        expansions: 'author_id,attachments.media_keys',
        'media.fields': 'url,preview_image_url,type',
      };

      if (paginationToken) {
        queryParams.pagination_token = paginationToken;
      }

      const response = (await this.withAuthRetry(
        () => this.client!.v2.get(`users/${this.userId}/bookmarks`, queryParams),
        `bookmarks page ${page}`
      )) as any;

      if (response.data && response.data.length > 0) {
        for (const tweet of response.data) {
          const author = response.includes?.users?.find((u: any) => u.id === tweet.author_id);
          const mediaItems = tweet.attachments?.media_keys
            ?.map((key: string) => {
              const media = response.includes?.media?.find((m: any) => m.media_key === key);
              if (media) {
                return {
                  type: media.type as 'photo' | 'video' | 'animated_gif',
                  url: media.url || media.preview_image_url || '',
                  previewUrl: media.preview_image_url,
                };
              }
              return null;
            })
            .filter(Boolean) as any[];

          const bookmark: XBookmark = {
            id: tweet.id,
            text: tweet.text,
            authorId: tweet.author_id || '',
            authorName: author?.name || 'Unknown',
            authorUsername: author?.username || 'unknown',
            createdAt: tweet.created_at || new Date().toISOString(),
            url: `https://x.com/${author?.username || 'i'}/status/${tweet.id}`,
            media: mediaItems && mediaItems.length > 0 ? mediaItems : undefined,
            metrics: tweet.public_metrics
              ? {
                  likeCount: tweet.public_metrics.like_count || 0,
                  retweetCount: tweet.public_metrics.retweet_count || 0,
                  replyCount: tweet.public_metrics.reply_count || 0,
                  bookmarkCount: tweet.public_metrics.bookmark_count || 0,
                }
              : undefined,
          };
          bookmarks.push(bookmark);
        }
      }

      paginationToken = response.meta?.next_token;
      console.log(
        `[X] Page ${page}: fetched ${response.data?.length || 0} bookmarks. Total: ${bookmarks.length}`
      );

      if (bookmarks.length >= 800 || !paginationToken || page >= MAX_PAGES) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (paginationToken);

    console.log(`[X] Successfully fetched ${bookmarks.length} bookmarks`);

    if (slackUserId && bookmarks.length > 0) {
      await storage.saveBookmarkCache(slackUserId, bookmarks, bookmarks.length);
    }

    return bookmarks;
  }
}

export default XService;
