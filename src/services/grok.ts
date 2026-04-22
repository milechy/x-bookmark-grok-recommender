import OpenAI from 'openai';
import { Recommendation, XBookmark, GrokRankingRequest } from '../types.js';

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

    const systemPrompt = `あなたは優秀なブックマーク推薦アシスタントです。
ユーザーのクエリに対して、提供された${limitedBookmarks.length}件のブックマークから**本当に関連性の高いものだけ**を厳しく選んでください。

重要なルール：
- 関連度スコアは0〜100の整数で、**ばらつきを大きくつける**（本当にマッチするものは80以上、微妙なものは50以下にする）。
- 同じような内容のブックマークは重複を避け、多様性を出す。
- クエリとの関連性を具体的に理由付けして評価。
- 上位8件のみをJSONで返し、関連度が高い順にソート。

関連度の基準:
- 95-100: 完璧に一致、クエリの核心を捉えている
- 80-94: 強く関連、主要な要素を含む
- 60-79: 部分的に関連
- 40-59: 少し関連
- <40: 無関係（選ばない）

出力は必ず以下のJSON形式で（追加のテキストは一切含めない）：
{
  "recommendations": [
    {
      "bookmark_id": "...",
      "score": 92,
      "reason": "クエリの内容と完全に一致する具体的な技術事例が記載されている",
      "relevance_explanation": "詳細な説明"
    }
  ]
}`;

    const userPrompt = `クエリ: ${query}

以下のブックマークからおすすめを抽出してください：
${bookmarksText}
`;

    try {
      const completion = await this.client.chat.completions.create({
        model: 'grok-beta',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
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
        return this.fallbackRanking(query, limitedBookmarks);
      }

      const recommendations: Recommendation[] = [];

      for (const item of items.slice(0, 8)) {
        const id = item.bookmark_id || item.id;
        const bookmark = limitedBookmarks.find((b) => b.id === id);
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
      return this.fallbackRanking(query, limitedBookmarks);
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
