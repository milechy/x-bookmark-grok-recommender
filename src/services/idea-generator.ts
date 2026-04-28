/**
 * 「生成モード」スタブ。
 *
 * 構想:
 *   - クエリ「この要件から新しい事業アイデアを2つ生成して」のように、
 *     ユーザーが事業仮説の生成を依頼してきたら、関連ブックマークを Grok で複数選び、
 *     さらに Grok で事業アイデア（タイトル / 仮説 / 想定顧客 / 必要技術）を合成する。
 *   - 結果を Obsidian の `10_Ideas/Business/` 配下にノート保存。
 *
 * 現状: ENABLE_GENERATION_MODE が "1" のときのみ有効化。デフォルト OFF。
 *      実際の Grok 呼び出しはまだ実装していない（次の PR で接続予定）。
 *
 * 既存の /bookmark フローには影響しない。
 */
import type { XBookmark } from '../types.js';

export const GENERATION_MODE_ENABLED = process.env.ENABLE_GENERATION_MODE === '1';

const TRIGGER_PATTERNS = [
  /事業アイデア(を|.*生成)/,
  /新しい事業仮説/,
  /アイデアを\s*\d+\s*つ生成/,
  /\bgenerate\s+ideas?\b/i,
];

/**
 * クエリが「生成モード」を意図しているか判定。
 * フラグ OFF なら常に false（既存挙動と完全互換）。
 */
export function isGenerationModeQuery(query: string): boolean {
  if (!GENERATION_MODE_ENABLED) return false;
  return TRIGGER_PATTERNS.some((re) => re.test(query));
}

export interface BusinessIdea {
  title: string;
  hypothesis: string;
  targetCustomer: string;
  requiredTech: string[];
  sourceBookmarkIds: string[];
}

export interface GenerationResult {
  disabled?: true;
  ideas?: BusinessIdea[];
  reason?: string;
}

/**
 * NOTE: 実装は次のフェーズ。現時点では disabled を返すだけ。
 * 呼び出し側は `disabled` の場合「生成モードは無効です」とユーザーに通知して終わる。
 */
export async function generateBusinessIdeas(
  _query: string,
  _bookmarks: XBookmark[]
): Promise<GenerationResult> {
  if (!GENERATION_MODE_ENABLED) {
    return { disabled: true, reason: 'ENABLE_GENERATION_MODE=1 が未設定です' };
  }
  return {
    disabled: true,
    reason: 'generateBusinessIdeas は未実装（次フェーズで Grok 接続予定）',
  };
}
