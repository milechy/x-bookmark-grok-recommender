/**
 * 簡易ログバッファ。console.log と同時に Vercel KV (Upstash Redis) の
 * リストにも書き出し、/api/logs から参照できるようにする。
 *
 * - keys:
 *   - debug:log      = ring buffer（最大 MAX_ENTRIES 件、LPUSH 新しい順）
 *   - debug:req:<id> = 1リクエスト単位のタイムライン（グルーピング用、TTL 1h）
 * - Upstash が無い環境（ローカル）では console.log のみ。
 */
import { kv } from '@vercel/kv';

const KEY_GLOBAL = 'debug:log';
const MAX_ENTRIES = 500;
const PER_REQ_TTL = 60 * 60; // 1h

const hasKV =
  !!process.env.KV_REST_API_URL || !!process.env.VERCEL_KV_REST_API_URL;

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  ts: number;
  iso: string;
  level: LogLevel;
  reqId?: string;
  tag?: string;
  msg: string;
  data?: unknown;
}

function toEntry(level: LogLevel, msg: string, extra?: { reqId?: string; tag?: string; data?: unknown }): LogEntry {
  const now = Date.now();
  return {
    ts: now,
    iso: new Date(now).toISOString(),
    level,
    reqId: extra?.reqId,
    tag: extra?.tag,
    msg,
    data: extra?.data,
  };
}

async function push(entry: LogEntry): Promise<void> {
  // コンソールには常に出す
  const head = `[${entry.iso}] ${entry.level.toUpperCase()} ${entry.reqId ? `[${entry.reqId}] ` : ''}${entry.tag ? `(${entry.tag}) ` : ''}${entry.msg}`;
  if (entry.level === 'error') console.error(head, entry.data ?? '');
  else if (entry.level === 'warn') console.warn(head, entry.data ?? '');
  else console.log(head, entry.data ?? '');

  if (!hasKV) return;
  try {
    const payload = JSON.stringify(entry);
    await kv.lpush(KEY_GLOBAL, payload);
    await kv.ltrim(KEY_GLOBAL, 0, MAX_ENTRIES - 1);
    if (entry.reqId) {
      const reqKey = `debug:req:${entry.reqId}`;
      await kv.rpush(reqKey, payload);
      await kv.expire(reqKey, PER_REQ_TTL);
    }
  } catch (e) {
    console.error('[debug-log] kv push failed', e);
  }
}

export class DebugLogger {
  readonly reqId: string;
  readonly startedAt: number;

  constructor(reqId: string) {
    this.reqId = reqId;
    this.startedAt = Date.now();
  }

  private elapsed(): string {
    return `+${Date.now() - this.startedAt}ms`;
  }

  info(msg: string, data?: unknown, tag?: string): Promise<void> {
    return push(toEntry('info', `${msg} ${this.elapsed()}`, { reqId: this.reqId, tag, data }));
  }
  warn(msg: string, data?: unknown, tag?: string): Promise<void> {
    return push(toEntry('warn', `${msg} ${this.elapsed()}`, { reqId: this.reqId, tag, data }));
  }
  error(msg: string, data?: unknown, tag?: string): Promise<void> {
    let serialized: unknown = data;
    if (data instanceof Error) {
      serialized = { name: data.name, message: data.message, stack: data.stack };
    }
    return push(toEntry('error', `${msg} ${this.elapsed()}`, { reqId: this.reqId, tag, data: serialized }));
  }
  debug(msg: string, data?: unknown, tag?: string): Promise<void> {
    return push(toEntry('debug', `${msg} ${this.elapsed()}`, { reqId: this.reqId, tag, data }));
  }
}

export function newReqId(prefix = 'r'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function getRecentLogs(limit = 200): Promise<LogEntry[]> {
  if (!hasKV) return [];
  try {
    const raw = await kv.lrange<string>(KEY_GLOBAL, 0, limit - 1);
    return raw
      .map((r) => {
        try {
          // @vercel/kv may auto-parse JSON; handle both cases
          if (typeof r === 'string') return JSON.parse(r) as LogEntry;
          return r as unknown as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((v): v is LogEntry => !!v);
  } catch (e) {
    console.error('[debug-log] kv read failed', e);
    return [];
  }
}

export async function clearLogs(): Promise<void> {
  if (!hasKV) return;
  try {
    await kv.del(KEY_GLOBAL);
  } catch (e) {
    console.error('[debug-log] kv clear failed', e);
  }
}
