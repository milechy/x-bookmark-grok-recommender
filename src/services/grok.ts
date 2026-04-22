import OpenAI, { APIError } from 'openai';
import { Recommendation, XBookmark } from '../types.js';

function formatGrokError(error: unknown): string {
  if (error instanceof APIError) {
    const body =
      error.error && typeof error.error === 'object' && 'message' in (error.error as object)
        ? String((error.error as { message?: string }).message)
        : '';
    return [error.status != null && `HTTP ${error.status}`, error.message || body].filter(Boolean).join(' ').trim();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Grok の bookmark_id（tweet id または本文冒頭）から XBookmark を解決 */
function resolveBookmarkByIdOrText(idOrRef: string | undefined, bookmarks: XBookmark[]): XBookmark | undefined {
  if (!idOrRef) return undefined;
  const ref = idOrRef.trim();
  if (!ref) return undefined;

  const byId = bookmarks.find((b) => b.id === ref);
  if (byId) return byId;

  const byPrefix = bookmarks.find((b) => b.text.startsWith(ref) || ref.startsWith(b.text.slice(0, Math.min(80, b.text.length))));
  if (byPrefix) return byPrefix;

  const head = ref.slice(0, 24);
  if (head.length > 2) {
    return bookmarks.find((b) => b.text.includes(ref) || b.text.includes(head));
  }
  return undefined;
}

export class GrokService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.GROK_API_KEY,
      baseURL: 'https://api.x.ai/v1',
    });
  }

  /**
   * Use Grok to semantically rank bookmarks based on user query.
   * Returns top 8 with scores and explanations in Japanese.
   */
  async rankBookmarks(query: string, bookmarks: XBookmark[]): Promise<Recommendation[]> {
    if (!process.env.GROK_API_KEY) {
      throw new Error('GROK_API_KEY is not set');
    }

    if (bookmarks.length === 0) {
      return [];
    }

    // Limit to top 50 most recent for prompt size
    const limitedBookmarks = bookmarks
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 50);

    const bookmarkList = limitedBookmarks.map((b, index) => ({
      bookmark_id: b.id,
      rank: index + 1,
      text: b.text.substring(0, 200),
      author: `@${b.authorUsername}`,
      date: new Date(b.createdAt).toLocaleDateString('ja-JP'),
      metrics: b.metrics ? `いいね:${b.metrics.likeCount} RT:${b.metrics.retweetCount}` : '',
    }));

    const bookmarksText = JSON.stringify(bookmarkList, null, 2);

    const systemPrompt = `あなたは厳しくて優秀なパーソナルブックマーク推薦アシスタントです。

ユーザーの長めの「クエリ」（アイデアや要件）と、提供されたブックマーク群から、**本当に価値のあるものだけを厳選**して推薦してください。

重要なルール：
- 関連度スコア（0〜100）は大きくばらつきをつける。本当に深くマッチするものは85〜98、普通レベルは70〜84、微妙なものは65以下にする。
- 各推薦に対して、**「クエリのどの部分にどう合っているか」**を具体的にコメントする。
  - クエリの具体的な言葉や意図を引用しながら説明する（例：「クエリの『既存のチャットアプリにエージェントを埋め込む』という部分に強く一致」）。
  - なぜこのブックマークが役立つのか、実用的価値を1〜2文で明確に述べる。
- 同じような内容のブックマークは避け、異なる角度（技術、事例、注意点、ツールなど）から多様性を出す。
- クエリとの関連性が薄いものは上位に出さない。

出力は必ず以下のJSON形式のみで返してください。他の説明文は一切出力しないこと。

{
  "recommendations": [
    {
      "bookmark_id": "ブックマークの識別子またはテキスト冒頭",
      "score": 92,
      "reason": "クエリの『AIエージェントをSlackやiMessageに直接組み込む』という核心に完全にマッチ。Hermes Agentが既存チャット内でAgentを動作させる実装例として非常に参考になる。",
      "relevance_explanation": "ユーザーは『新しいアプリをインストールせずに日常のチャット内でエージェントを使いたい』と述べている。このブックマークはSpectrumやHermesの統合手法と具体的な技術スタックを紹介しており、すぐに参考にできる。"
    }
  ]
}
`;

    const userPrompt = `ユーザーのクエリ：
${query}

以下のブックマークから、上記のルールで厳選しておすすめを抽出してください：

${bookmarksText}
`;

    const model = process.env.GROK_MODEL || 'grok-4.20-reasoning';

    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0]?.message?.content || '{}';
      let items: Array<{
        bookmark_id?: string;
        id?: string;
        score: number;
        reason: string;
        relevance_explanation?: string;
        relevanceExplanation?: string;
      }> = [];

      try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed?.recommendations)) {
          items = parsed.recommendations;
        } else if (Array.isArray(parsed)) {
          items = parsed;
        } else if (parsed && typeof parsed === 'object') {
          const firstArray = Object.values(parsed).find((v) => Array.isArray(v));
          if (firstArray) items = firstArray as any[];
        }
      } catch (e) {
        console.error('[Grok] Failed to parse JSON:', content);
        if (process.env.GROK_ALLOW_KEYWORD_FALLBACK === '1') {
          return this.fallbackRanking(query, limitedBookmarks);
        }
        throw new Error(
          'Grokの返答をJSONとして解釈できませんでした。しばらく待って /bookmark を再実行するか、クエリを短くしてください。'
        );
      }

      const recommendations: Recommendation[] = [];

      for (const item of items.slice(0, 8)) {
        const id = item.bookmark_id || item.id;
        const bookmark = resolveBookmarkByIdOrText(id, limitedBookmarks);
        if (bookmark) {
          recommendations.push({
            bookmark,
            score: Math.min(100, Math.max(0, Math.round(item.score) || 70)),
            reason: item.reason || '関連性が高いブックマーク',
            relevanceExplanation: item.relevance_explanation || item.relevanceExplanation,
          });
        }
      }

      // If less than 8, fill with fallback
      if (recommendations.length < 8) {
        const remaining = limitedBookmarks
          .filter(b => !recommendations.some(r => r.bookmark.id === b.id))
          .slice(0, 8 - recommendations.length);
        
        remaining.forEach((bookmark, idx) => {
          recommendations.push({
            bookmark,
            score: Math.max(40, 70 - idx * 5),
            reason: '関連する可能性のあるブックマーク',
          });
        });
      }

      console.log(`[Grok] Ranked ${recommendations.length} recommendations for query: "${query}"`);
      return recommendations;

    } catch (error) {
      console.error('[Grok] API Error:', error);
      if (process.env.GROK_ALLOW_KEYWORD_FALLBACK === '1') {
        return this.fallbackRanking(query, limitedBookmarks);
      }
      const detail = formatGrokError(error);
      throw new Error(
        `Grok API から正常な応答がありませんでした。${detail}\n*確認:* クレジット残高・GROK_API_KEY・モデル名（GROK_MODEL）`
      );
    }
  }

  private fallbackRanking(query: string, bookmarks: XBookmark[]): Recommendation[] {
    console.log('[Grok] Using fallback ranking');
    // Simple TF-like scoring based on keyword overlap + recency
    const queryTerms = query.toLowerCase().split(/\s+/);
    
    return bookmarks
      .slice(0, 8)
      .map((bookmark, _index) => {
        const text = bookmark.text.toLowerCase();
        let score = 60;
        
        queryTerms.forEach(term => {
          if (text.includes(term)) score += 15;
          if (bookmark.authorUsername.toLowerCase().includes(term)) score += 5;
        });
        
        // Recency bonus
        const daysOld = (Date.now() - new Date(bookmark.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        score = Math.max(30, score - Math.floor(daysOld / 30));
        
        return {
          bookmark,
          score: Math.min(98, Math.floor(score)),
          reason: queryTerms.some(t => text.includes(t)) 
            ? 'キーワードが一致' 
            : '最近の関連ブックマーク',
        };
      })
      .sort((a, b) => b.score - a.score);
  }
}

export default GrokService;
