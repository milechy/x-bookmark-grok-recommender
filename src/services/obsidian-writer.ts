/**
 * Obsidian ノートの生成 + 書き込みアダプタ。
 *
 * 動作環境に応じて 3 つのモードを自動選択する:
 *   - github : OBSIDIAN_GITHUB_REPO + OBSIDIAN_GITHUB_TOKEN がある → GitHub Contents API で commit
 *   - local  : OBSIDIAN_VAULT_PATH があり Vercel 上ではない    → 直接 fs.writeFile
 *   - slack-upload : 上記いずれも未設定 → 呼び出し側に Buffer を返し Slack へ files.uploadV2
 *
 * 既存システム（X/Grok/Slack/KV）には一切依存しない純粋ユーティリティに保つ。
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { XBookmark } from '../types.js';

export type ObsidianMode = 'local' | 'github' | 'slack-upload';

export interface BuiltNote {
  /** "00_Inbox/X-Bookmarks/2026-04-28-1234567890.md" */
  relPath: string;
  /** "2026-04-28-1234567890.md" */
  filename: string;
  /** UTF-8 markdown */
  content: string;
  /** 元ブックマーク ID */
  tweetId: string;
}

export interface ObsidianWriteOptions {
  bookmarks: XBookmark[];
  /** 元クエリ（任意。frontmatter に original_query として残す） */
  query?: string;
  /** デフォルト: OBSIDIAN_NOTE_FOLDER または "00_Inbox/X-Bookmarks" */
  folder?: string;
  /** 上書きを禁止するか（GitHub モードのみ意味あり）。デフォルト false */
  noOverwrite?: boolean;
}

export interface ObsidianWriteResult {
  mode: ObsidianMode;
  written: Array<{ tweetId: string; path: string }>;
  failed: Array<{ tweetId: string; error: string }>;
  /** slack-upload モードでのみ使用 */
  files?: BuiltNote[];
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (no I/O)                                                      */
/* -------------------------------------------------------------------------- */

const DEFAULT_FOLDER = '00_Inbox/X-Bookmarks';

/** YAML 文字列値の最低限のエスケープ。改行/ダブルクォートを潰す */
function escapeYamlScalar(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ').trim();
}

/** YYYY-MM-DD（UTC）。createdAt が壊れていたら今日の日付にフォールバック */
function dateStamp(iso: string | undefined): string {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

/** ファイルシステムで安全な相対パスかチェック（".." 等の混入排除） */
function safeJoin(folder: string, filename: string): string {
  const cleaned = path.posix.normalize(folder).replace(/^\/+/, '');
  if (cleaned.split('/').some((p) => p === '..')) {
    throw new Error(`不正なフォルダ指定: ${folder}`);
  }
  return path.posix.join(cleaned, filename);
}

/** XBookmark から frontmatter 文字列を生成 */
export function buildFrontmatter(b: XBookmark, extra: { query?: string } = {}): string {
  const author = escapeYamlScalar(`@${b.authorUsername} (${b.authorName})`);
  const lines = [
    '---',
    'source: X',
    `date: ${b.createdAt || new Date().toISOString()}`,
    `tweet_id: "${b.id}"`,
    `author: "${author}"`,
    `url: ${b.url}`,
    'business_potential: 未評価',
    'key_insight: ',
    'tags: []',
  ];
  if (extra.query) {
    lines.push(`original_query: "${escapeYamlScalar(extra.query)}"`);
  }
  if (b.metrics) {
    lines.push(
      `metrics: { likes: ${b.metrics.likeCount}, retweets: ${b.metrics.retweetCount}, replies: ${b.metrics.replyCount} }`
    );
  }
  lines.push('---');
  return lines.join('\n');
}

/** ノート本文を生成 */
export function buildNoteBody(b: XBookmark): string {
  const out: string[] = [];
  out.push(`# ${b.authorName} (@${b.authorUsername})`);
  out.push('');
  out.push(b.text);
  out.push('');

  if (b.media && b.media.length > 0) {
    out.push('## メディア');
    for (const m of b.media) {
      const u = m.previewUrl || m.url;
      if (u) out.push(`![](${u})`);
    }
    out.push('');
  }

  out.push('---');
  out.push(`*Original: ${b.url}*`);
  out.push(`*Saved by FounderOS v2 on ${new Date().toISOString()}*`);
  return out.join('\n');
}

/** 1 件分の note を組み立てる（I/O 一切なし） */
export function buildNote(b: XBookmark, folder: string, query?: string): BuiltNote {
  const filename = `${dateStamp(b.createdAt)}-${b.id}.md`;
  const relPath = safeJoin(folder, filename);
  const content = `${buildFrontmatter(b, { query })}\n\n${buildNoteBody(b)}\n`;
  return { relPath, filename, content, tweetId: b.id };
}

/* -------------------------------------------------------------------------- */
/* Mode selection                                                             */
/* -------------------------------------------------------------------------- */

export function detectObsidianMode(): ObsidianMode {
  if (process.env.OBSIDIAN_GITHUB_REPO && process.env.OBSIDIAN_GITHUB_TOKEN) return 'github';
  if (process.env.OBSIDIAN_VAULT_PATH && !process.env.VERCEL) return 'local';
  return 'slack-upload';
}

/* -------------------------------------------------------------------------- */
/* Writers                                                                    */
/* -------------------------------------------------------------------------- */

async function writeLocal(notes: BuiltNote[]): Promise<ObsidianWriteResult> {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  if (!root) {
    return {
      mode: 'local',
      written: [],
      failed: notes.map((n) => ({ tweetId: n.tweetId, error: 'OBSIDIAN_VAULT_PATH 未設定' })),
    };
  }
  const written: ObsidianWriteResult['written'] = [];
  const failed: ObsidianWriteResult['failed'] = [];
  for (const n of notes) {
    try {
      const fullPath = path.join(root, n.relPath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, n.content, 'utf8');
      written.push({ tweetId: n.tweetId, path: fullPath });
    } catch (e) {
      failed.push({ tweetId: n.tweetId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { mode: 'local', written, failed };
}

async function writeGitHub(
  notes: BuiltNote[],
  opts: { noOverwrite?: boolean }
): Promise<ObsidianWriteResult> {
  const repo = process.env.OBSIDIAN_GITHUB_REPO!;
  const token = process.env.OBSIDIAN_GITHUB_TOKEN!;
  const branch = process.env.OBSIDIAN_GITHUB_BRANCH || 'main';
  const author = process.env.OBSIDIAN_GITHUB_AUTHOR || 'FounderOS Bot';
  const email = process.env.OBSIDIAN_GITHUB_EMAIL || 'founderos-bot@noreply.local';

  const written: ObsidianWriteResult['written'] = [];
  const failed: ObsidianWriteResult['failed'] = [];

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'founderos-v2',
  };

  for (const n of notes) {
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURI(n.relPath)}`;
    try {
      let sha: string | undefined;
      const head = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, { headers });
      if (head.ok) {
        const json = (await head.json()) as { sha?: string };
        sha = json.sha;
        if (opts.noOverwrite) {
          failed.push({ tweetId: n.tweetId, error: '既存ファイル（noOverwrite=true）' });
          continue;
        }
      } else if (head.status !== 404) {
        const t = await head.text();
        failed.push({ tweetId: n.tweetId, error: `GitHub HEAD ${head.status}: ${t.slice(0, 200)}` });
        continue;
      }

      const put = await fetch(url, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `feat(bookmark): add ${n.filename}`,
          content: Buffer.from(n.content, 'utf8').toString('base64'),
          branch,
          committer: { name: author, email },
          author: { name: author, email },
          ...(sha ? { sha } : {}),
        }),
      });

      if (!put.ok) {
        const t = await put.text();
        failed.push({ tweetId: n.tweetId, error: `GitHub PUT ${put.status}: ${t.slice(0, 200)}` });
        continue;
      }
      written.push({ tweetId: n.tweetId, path: n.relPath });
    } catch (e) {
      failed.push({ tweetId: n.tweetId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { mode: 'github', written, failed };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function writeBookmarksToObsidian(
  options: ObsidianWriteOptions
): Promise<ObsidianWriteResult> {
  const folder = options.folder ?? process.env.OBSIDIAN_NOTE_FOLDER ?? DEFAULT_FOLDER;
  const notes = options.bookmarks.map((b) => buildNote(b, folder, options.query));
  const mode = detectObsidianMode();

  if (mode === 'local') return writeLocal(notes);
  if (mode === 'github') return writeGitHub(notes, { noOverwrite: !!options.noOverwrite });

  // slack-upload モード: ファイル本体は呼び出し側が files.uploadV2 する
  return {
    mode: 'slack-upload',
    written: notes.map((n) => ({ tweetId: n.tweetId, path: n.relPath })),
    failed: [],
    files: notes,
  };
}

/** モード説明（表示用） */
export function describeMode(mode: ObsidianMode): string {
  switch (mode) {
    case 'local':
      return `ローカル (${process.env.OBSIDIAN_VAULT_PATH})`;
    case 'github':
      return `GitHub (${process.env.OBSIDIAN_GITHUB_REPO}@${process.env.OBSIDIAN_GITHUB_BRANCH || 'main'})`;
    case 'slack-upload':
      return 'Slack 添付ファイル（手動で vault へ）';
  }
}
