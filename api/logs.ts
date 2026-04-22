/**
 * 直近のデバッグログをブラウザから閲覧できるエンドポイント。
 *
 * 使い方:
 *   GET /api/logs?token=XXX            → HTML で整形表示
 *   GET /api/logs?token=XXX&format=json → JSON
 *   GET /api/logs?token=XXX&clear=1     → バッファを全消去
 *   GET /api/logs?token=XXX&filter=bg   → msg/tag/reqId に "bg" を含むものだけ
 *
 * token は 環境変数 LOGS_ACCESS_TOKEN と一致必須。未設定ならアクセス不可。
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getRecentLogs, clearLogs, type LogEntry } from '../src/debug-log.js';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtData(data: unknown): string {
  if (data === undefined || data === null || data === '') return '';
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    if (s === '""' || s === '{}') return '';
    return s;
  } catch {
    return String(data);
  }
}

function renderHtml(logs: LogEntry[], filter: string): string {
  const rows = logs
    .map((l) => {
      const color =
        l.level === 'error'
          ? '#ff6161'
          : l.level === 'warn'
            ? '#ffc400'
            : l.level === 'debug'
              ? '#808080'
              : '#9effb0';
      const data = fmtData(l.data);
      return `<tr>
        <td class="ts">${esc(l.iso)}</td>
        <td class="lv" style="color:${color}">${esc(l.level)}</td>
        <td class="rid">${esc(l.reqId || '')}</td>
        <td class="tag">${esc(l.tag || '')}</td>
        <td class="msg">${esc(l.msg)}${data ? `<pre>${esc(data)}</pre>` : ''}</td>
      </tr>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>X Bookmark Agent - Debug Logs</title>
<meta http-equiv="refresh" content="5" />
<style>
  body { background: #111; color: #eee; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 0; }
  header { padding: 12px 20px; background: #1a1a1a; border-bottom: 1px solid #333; position: sticky; top: 0; z-index: 5;
           display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 14px; color: #9effb0; }
  header a, header form button { color: #7cc4ff; background: transparent; border: 1px solid #334; padding: 4px 10px;
                                 border-radius: 4px; text-decoration: none; font-size: 12px; cursor: pointer; }
  header .meta { color: #888; font-size: 12px; }
  header input { background: #1f1f1f; color: #eee; border: 1px solid #334; padding: 4px 8px; border-radius: 4px; font-family: inherit; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  tr { border-bottom: 1px solid #222; }
  tr:hover { background: #181818; }
  td { padding: 6px 10px; vertical-align: top; }
  td.ts { color: #888; white-space: nowrap; }
  td.lv { font-weight: bold; text-transform: uppercase; white-space: nowrap; }
  td.rid { color: #7cc4ff; white-space: nowrap; font-size: 11px; }
  td.tag { color: #c4a1ff; white-space: nowrap; }
  td.msg { word-break: break-word; }
  pre { background: #1a1a1a; color: #ddd; padding: 8px; border-radius: 4px; margin: 6px 0 0; white-space: pre-wrap; word-break: break-word;
        max-height: 300px; overflow: auto; font-size: 11px; }
  .empty { padding: 40px; text-align: center; color: #888; }
</style>
</head>
<body>
<header>
  <h1>X Bookmark Agent — Debug Logs</h1>
  <span class="meta">${logs.length} 件 / 5秒ごとに自動リロード</span>
  <form method="get" action="/api/logs" style="display:flex; gap:6px; align-items:center;">
    <input type="hidden" name="token" value="${esc(new URLSearchParams(globalThis.location?.search || '').get('token') || '')}" />
    <input name="filter" value="${esc(filter)}" placeholder="filter..." />
    <button type="submit">絞り込み</button>
  </form>
  <a href="?token=__TOKEN__">リセット</a>
  <a href="?token=__TOKEN__&format=json">JSON</a>
  <a href="?token=__TOKEN__&clear=1" onclick="return confirm('全ログを削除しますか？');" style="color:#ff8080">全削除</a>
</header>
${logs.length === 0 ? '<div class="empty">ログはまだありません。Slack で /bookmark を実行してみてください。</div>' : ''}
<table>
<thead><tr>
  <th style="text-align:left;padding:8px 10px;color:#666">Time</th>
  <th style="text-align:left;padding:8px 10px;color:#666">Lvl</th>
  <th style="text-align:left;padding:8px 10px;color:#666">ReqId</th>
  <th style="text-align:left;padding:8px 10px;color:#666">Tag</th>
  <th style="text-align:left;padding:8px 10px;color:#666">Message</th>
</tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body></html>`;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const expected = process.env.LOGS_ACCESS_TOKEN;
  const token = (req.query.token as string | undefined) || '';
  if (!expected) {
    res.status(503).send('LOGS_ACCESS_TOKEN が未設定です。Vercel 環境変数に追加してください。');
    return;
  }
  if (token !== expected) {
    res.status(401).send('Unauthorized: ?token=... を付けてください');
    return;
  }

  if (req.query.clear === '1') {
    await clearLogs();
    res.status(200).send('cleared');
    return;
  }

  const limit = Math.min(parseInt((req.query.limit as string) || '300', 10) || 300, 500);
  const filter = ((req.query.filter as string) || '').toLowerCase();
  let logs = await getRecentLogs(limit);
  if (filter) {
    logs = logs.filter(
      (l) =>
        (l.msg || '').toLowerCase().includes(filter) ||
        (l.tag || '').toLowerCase().includes(filter) ||
        (l.reqId || '').toLowerCase().includes(filter) ||
        (l.level || '').toLowerCase().includes(filter)
    );
  }

  if (req.query.format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(logs, null, 2));
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const html = renderHtml(logs, filter).replace(/__TOKEN__/g, encodeURIComponent(token));
  res.status(200).send(html);
}
