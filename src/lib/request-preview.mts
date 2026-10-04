import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import type { HostMessage, StreamOptions } from '../host-types.mjs';
import { detectProtocol } from './protocol.mjs';
import type { CompiledPreset } from './types.mjs';
type RequestDebug = Pick<CompiledPreset, 'warnings' | 'promptRegex'>;

type Origin = { role: string; hash: string; history: boolean };
type Snapshot = { id: string; sessionId: string; at: string; source: 'wire' | 'adapter-input'; protocol: string; attempt: number;
  requestNo: number; status: string; raw?: string; unavailable?: string; error?: string; origins: Origin[]; bytes: number; debug?: RequestDebug };
type Frame = { store: RequestSnapshots; snapshot: Snapshot; origins: Origin[]; attempts: number };
const KEY = Symbol.for('dsh-preset-enhance.request-preview-context');
const globals = globalThis as unknown as Record<symbol, AsyncLocalStorage<Frame> | undefined>;
const context = globals[KEY] ??= new AsyncLocalStorage<Frame>();
const text = (m: HostMessage) => m.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') ?? '';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const messageOrigins = (messages: HostMessage[]): Origin[] => messages.map(m => ({ role: m.role, hash: hash(text(m)), history: !['plugin', 'system-prompt', 'runtime-context'].includes(m.source?.kind ?? '') && m.source?.plugin !== 'dsh-preset-enhance' && m.role !== 'system' }));

/** Exact wire text is bounded and kept only in memory; never exports headers or credentials. */
export class RequestSnapshots {
  private rows = new Map<string, Snapshot>();
  private listeners = new Set<{ sessionId: string; callback: (id: string) => void; close: () => void }>();
  private bytes = 0;
  private sequence = 0;
  private maxBytes: number;
  private perSession: number;
  constructor(maxBytes = 32 * 1024 * 1024, perSession = 4) { this.maxBytes = maxBytes; this.perSession = perSession; }
  private notify(sessionId: string, id: string) {
    if (this.latestId(sessionId) !== id) return;
    for (const listener of this.listeners) if (listener.sessionId === sessionId) { try { listener.callback(id); } catch {} }
  }
  latestId(sessionId: string) { return [...this.rows.values()].findLast(row => row.sessionId === sessionId)?.id; }
  begin(sessionId: string, options: StreamOptions, debug?: RequestDebug) {
    const input: Record<string, unknown> = {};
    for (const key of ['provider', 'model', 'messages', 'system', 'tools', 'reasoningEffort', 'temperature', 'maxTokens', 'stop']) if (options[key] !== undefined) input[key] = options[key];
    const origins = messageOrigins(options.messages ?? []);
    const snapshot: Snapshot = { id: randomUUID(), sessionId, at: new Date().toISOString(), source: 'adapter-input', protocol: 'unknown',
      requestNo: ++this.sequence, attempt: 0, status: 'preparing', origins, bytes: 0, debug: debug ? structuredClone(debug) : undefined };
    this.rows.set(snapshot.id, snapshot);
    this.setRaw(snapshot, JSON.stringify(input));
    this.trim(); this.notify(sessionId, snapshot.id);
    return { store: this, snapshot, origins, attempts: 0 } satisfies Frame;
  }
  private setRaw(row: Snapshot, raw: string) {
    this.bytes -= row.bytes;
    const bytes = Buffer.byteLength(raw);
    row.bytes = bytes <= this.maxBytes ? bytes : 0;
    row.raw = bytes <= this.maxBytes ? raw : undefined;
    row.unavailable = bytes <= this.maxBytes ? undefined : '请求正文超过预览内存上限';
    this.bytes += row.bytes;
  }
  private trim() {
    const counts = new Map<string, number>();
    for (const row of [...this.rows.values()].reverse()) {
      const count = (counts.get(row.sessionId) ?? 0) + 1; counts.set(row.sessionId, count);
      if (count > this.perSession) this.expire(row);
    }
    while (this.bytes > this.maxBytes || this.rows.size > 128) {
      const row = this.rows.values().next().value as Snapshot | undefined;
      if (!row) break;
      this.expire(row);
    }
  }
  private expire(row: Snapshot) {
    this.rows.delete(row.id); this.bytes -= row.bytes; row.bytes = 0; row.raw = undefined; row.unavailable = '快照已淘汰';
  }
  wire(frame: Frame, raw: string, protocol: string) {
    if (frame.attempts++) {
      const previous = frame.snapshot;
      frame.snapshot = { ...previous, id: randomUUID(), at: new Date().toISOString(), bytes: 0, error: undefined };
      this.rows.set(frame.snapshot.id, frame.snapshot);
    }
    const row = frame.snapshot;
    if (!this.rows.has(row.id)) this.rows.set(row.id, row);
    row.attempt = frame.attempts; row.source = 'wire'; row.protocol = protocol; row.status = 'sending';
    this.setRaw(row, raw); this.trim(); this.notify(row.sessionId, row.id);
    return (status: string) => { row.status = status; this.notify(row.sessionId, row.id); };
  }
  fail(frame: Frame, error: unknown) {
    frame.snapshot.status = 'failed'; frame.snapshot.error = error instanceof Error ? error.message : '请求失败';
    this.notify(frame.snapshot.sessionId, frame.snapshot.id);
  }
  preparationFailed(sessionId: string, error: unknown) {
    const frame = this.begin(sessionId, {});
    this.bytes -= frame.snapshot.bytes; frame.snapshot.bytes = 0; frame.snapshot.raw = undefined;
    frame.snapshot.unavailable = '准备失败，未发送'; this.fail(frame, error);
  }
  complete(frame: Frame) {
    if (frame.snapshot.source === 'adapter-input' && frame.snapshot.status !== 'failed') { frame.snapshot.status = 'unconfirmed'; this.notify(frame.snapshot.sessionId, frame.snapshot.id); }
  }
  read(sessionId: string, id?: string) {
    const rows = [...this.rows.values()].filter(row => row.sessionId === sessionId);
    const row = id ? rows.find(item => item.id === id) : rows.at(-1);
    if (!row) return null;
    const { origins, bytes, debug, ...safe } = row;
    let body;
    try { body = row.raw ? JSON.parse(row.raw) : undefined; } catch {}
    return { ...safe, warnings: debug?.warnings ?? [], promptRegex: debug?.promptRegex, messages: body ? previewMessages(body, origins) : [],
      choices: rows.map(({ id, at, source, attempt, requestNo, status }) => ({ id, at, source, attempt, requestNo, status })) };
  }
  subscribe(sessionId: string, callback: (id: string) => void, close: () => void) {
    const lease = { sessionId, callback, close }; this.listeners.add(lease);
    return () => { this.listeners.delete(lease); };
  }
  close() { for (const lease of this.listeners) lease.close(); this.listeners.clear(); this.rows.clear(); this.bytes = 0; }
}

/** Kept separate from wire JSON; uncertain/mixed source messages stay visible. */
export function previewMessages(body: Record<string, any>, origins: Origin[] = []): HostMessage[] {
  const messages: HostMessage[] = [];
  const used = new Set<number>();
  if (body.system !== undefined) messages.push({ role: 'system', content: [{ type: 'text', text: typeof body.system === 'string' ? body.system : JSON.stringify(body.system, null, 2) }], previewHistory: false });
  const rows = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
  for (const m of rows) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [{ type: 'text', text: JSON.stringify(m.content ?? '') }];
    const plain = content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('\n');
    const found = origins.findIndex((o, i) => !used.has(i) && o.role === m.role && o.hash === hash(plain));
    if (found >= 0) used.add(found);
    const extra = Object.fromEntries(Object.entries(m).filter(([key]) => !['role', 'content', 'source', 'id'].includes(key)));
    messages.push({ ...m, role: m.role ?? 'unknown', content: [...content, ...(Object.keys(extra).length ? [{ type: 'wire-fields', text: JSON.stringify(extra, null, 2) }] : [])],
      previewHistory: m.previewHistory === true || (m.source?.kind === 'user' || m.source?.kind === 'tool') || (found >= 0 && origins[found].history) });
  }
  return messages;
}

/** Iteration runs inside ALS too, so concurrent generators with identical text cannot mix traces. */
export async function* traceRequest(store: RequestSnapshots, sessionId: string, options: StreamOptions, source: AsyncIterable<unknown>, debug?: RequestDebug) {
  const frame = store.begin(sessionId, options, debug), iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await context.run(frame, () => iterator.next());
      if (next.done) break;
      const event = next.value as { type?: string; reason?: { kind?: string; failure?: { message?: string } } };
      if (event?.type === 'finish' && ['error', 'aborted'].includes(event.reason?.kind ?? '')) store.fail(frame, new Error(event.reason?.failure?.message ?? '接口请求未完成'));
      yield next.value;
    }
    store.complete(frame);
  } catch (error) { store.fail(frame, error); throw error; }
  finally { if (iterator.return) await context.run(frame, () => iterator.return!()); }
}

/** Called after all plugin rewrites, immediately before the transport. Does not read streams. */
export function captureOutgoingRequest(input: unknown, init: unknown) {
  const frame = context.getStore();
  if (!frame) return;
  const observation = detectProtocol(input, init);
  if (observation.method !== 'POST' || observation.protocol === 'unknown' || (observation.sessionId && observation.sessionId !== frame.snapshot.sessionId)) return;
  const body = (init as { body?: unknown } | undefined)?.body;
  if (typeof body !== 'string') return;
  return frame.store.wire(frame, body, observation.protocol);
}
