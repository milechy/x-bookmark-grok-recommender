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
      id: b.id,
      rank: index + 1,
      text: b.text.substring(0, 200), // truncate for prompt
      author: `@${b.authorUsername}`,
      date: new Date(b.createdAt).toLocaleDateString('ja-JP'),
      metrics: b.metrics ? `いいね:${b.metrics.likeCount} RT:${b.metrics.retweetCount}` : '',
    }));

    const prompt = `あなたは優秀なX(Twitter)ブックマーク推薦AIです。
ユーザーの「${query}」という要件に基づいて、以下のブックマークを関連度でランキングしてください。

**要件**: ${query}

**ブックマーク一覧**:
${JSON.stringify(bookmarkList, null, 2)}

**指示**:
1. 各ブックマークの関連度を0-100の整数スコアで評価（100が完全一致）
2. 日本語で簡潔な理由を付けてください（最大30文字）
3. ユーザーの要件に最も関連する上位8件を選択
4. 投稿の文脈、トピック、著者の専門性、タイミングなどを考慮
5. JSON形式で正確に出力してください

出力形式（JSON配列）:
[
  {
    "id": "tweet_id",
    "score": 94,
    "reason": "要件の核心であるAI技術について詳細に議論している",
    "relevanceExplanation": "詳細な説明"
  },
  ...
]

関連度の基準:
- 95-100: 完璧に一致、要件の核心を捉えている
- 80-94: 強く関連、主要な要素を含む
- 60-79: 部分的に関連
- 40-59: 少し関連
- <40: 無関係

JSONのみで返答してください。追加のテキストは一切含めないでください。`;

    try {
      const completion = await this.client.chat.completions.create({
        model: 'grok-beta', // or 'grok-2-1212' depending on availability
        messages: [
          { 
            role: 'system', 
            content: 'あなたは正確なJSONのみを出力するAIアシスタントです。ユーザーのクエリに基づいてブックマークをランキングします。' 
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1, // low for consistent JSON
        max_tokens: 4000,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices[0]?.message?.content || '{}';
      let parsed: Array<{id: string; score: number; reason: string; relevanceExplanation?: string}>;

      try {
        parsed = JSON.parse(content);
        if (!Array.isArray(parsed)) {
          parsed = [parsed]; // fallback
        }
      } catch (e) {
        console.error('[Grok] Failed to parse JSON:', content);
        // Fallback to simple ranking by length or recency
        return this.fallbackRanking(query, limitedBookmarks);
      }

      const recommendations: Recommendation[] = [];

      for (const item of parsed.slice(0, 8)) {
        const bookmark = limitedBookmarks.find(b => b.id === item.id) || limitedBookmarks[0];
        if (bookmark) {
          recommendations.push({
            bookmark,
            score: Math.min(100, Math.max(0, item.score || 75)),
            reason: item.reason || '関連性が高いブックマーク',
            relevanceExplanation: item.relevanceExplanation,
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
