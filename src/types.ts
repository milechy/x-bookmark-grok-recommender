export interface XBookmark {
  id: string;
  text: string;
  authorId: string;
  authorName: string;
  authorUsername: string;
  createdAt: string;
  url: string;
  media?: {
    type: 'photo' | 'video' | 'animated_gif';
    url: string;
    previewUrl?: string;
  }[];
  metrics?: {
    likeCount: number;
    retweetCount: number;
    replyCount: number;
    bookmarkCount: number;
  };
}

export interface BookmarkCache {
  userId: string;
  bookmarks: XBookmark[];
  lastSynced: string;
  totalFetched: number;
}

export interface UserTokens {
  slackUserId: string;
  xAccessToken: string;
  xRefreshToken?: string;
  xTokenExpiresAt?: number;
  createdAt: string;
}

export interface Recommendation {
  bookmark: XBookmark;
  score: number; // 0-100
  reason: string;
  relevanceExplanation?: string;
}

export interface GrokRankingRequest {
  query: string;
  bookmarks: Array<{
    id: string;
    text: string;
    author: string;
    date: string;
  }>;
}

export interface SlackCommandContext {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  response_url?: string;
}

export interface BlockCard {
  type: 'section' | 'divider' | 'actions' | 'header';
  text?: string;
  accessory?: any;
  elements?: any[];
  block_id?: string;
}

export type ErrorType = 'auth' | 'api' | 'rate_limit' | 'validation' | 'internal';

export interface BotError extends Error {
  type: ErrorType;
  userMessage: string;
  isUserFriendly: boolean;
}
