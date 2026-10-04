import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { detectProtocol } from './protocol.mjs';
const KEY = Symbol.for('dsh-preset-enhance.request-preview-context');
const globals = globalThis;
const context = globals[KEY] ??= new AsyncLocalStorage();
const text = (m) => m.content?.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') ?? '';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const messageOrigins = (messages) => messages.map(m => ({ role: m.role, hash: hash(text(m)), history: !['plugin', 'system-prompt', 'runtime-context'].includes(m.source?.kind ?? '') && m.source?.plugin !== 'dsh-preset-enhance' && m.role !== 'system' }));
/** Exact wire text is bounded and kept only in memory; never exports headers or credentials. */
export class RequestSnapshots {
    rows = new Map();
    listeners = new Set();
    bytes = 0;
    sequence = 0;
    maxBytes;
    perSession;
    constructor(maxBytes = 32 * 1024 * 1024, perSession = 4) { this.maxBytes = maxBytes; this.perSession = perSession; }
    notify(sessionId, id) {
        if (this.latestId(sessionId) !== id)
            return;
        for (const listener of this.listeners)
            if (listener.sessionId === sessionId) {
                try {
                    listener.callback(id);
                }
                catch { }
            }
    }
    latestId(sessionId) { return [...this.rows.values()].findLast(row => row.sessionId === sessionId)?.id; }
    begin(sessionId, options, debug) {
        const input = {};
        for (const key of ['provider', 'model', 'messages', 'system', 'tools', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'])
            if (options[key] !== undefined)
                input[key] = options[key];
        const origins = messageOrigins(options.messages ?? []);
        const snapshot = { id: randomUUID(), sessionId, at: new Date().toISOString(), source: 'adapter-input', protocol: 'unknown',
            requestNo: ++this.sequence, attempt: 0, status: 'preparing', origins, bytes: 0, debug: debug ? structuredClone(debug) : undefined };
        this.rows.set(snapshot.id, snapshot);
        this.setRaw(snapshot, JSON.stringify(input));
        this.trim();
        this.notify(sessionId, snapshot.id);
        return { store: this, snapshot, origins, attempts: 0 };
    }
    setRaw(row, raw) {
        this.bytes -= row.bytes;
        const bytes = Buffer.byteLength(raw);
        row.bytes = bytes <= this.maxBytes ? bytes : 0;
        row.raw = bytes <= this.maxBytes ? raw : undefined;
        row.unavailable = bytes <= this.maxBytes ? undefined : '请求正文超过预览内存上限';
        this.bytes += row.bytes;
    }
    trim() {
        const counts = new Map();
        for (const row of [...this.rows.values()].reverse()) {
            const count = (counts.get(row.sessionId) ?? 0) + 1;
            counts.set(row.sessionId, count);
            if (count > this.perSession)
                this.expire(row);
        }
        while (this.bytes > this.maxBytes || this.rows.size > 128) {
            const row = this.rows.values().next().value;
            if (!row)
                break;
            this.expire(row);
        }
    }
    expire(row) {
        this.rows.delete(row.id);
        this.bytes -= row.bytes;
        row.bytes = 0;
        row.raw = undefined;
        row.unavailable = '快照已淘汰';
    }
    wire(frame, raw, protocol) {
        if (frame.attempts++) {
            const previous = frame.snapshot;
            frame.snapshot = { ...previous, id: randomUUID(), at: new Date().toISOString(), bytes: 0, error: undefined };
            this.rows.set(frame.snapshot.id, frame.snapshot);
        }
        const row = frame.snapshot;
        if (!this.rows.has(row.id))
            this.rows.set(row.id, row);
        row.attempt = frame.attempts;
        row.source = 'wire';
        row.protocol = protocol;
        row.status = 'sending';
        this.setRaw(row, raw);
        this.trim();
        this.notify(row.sessionId, row.id);
        return (status) => { row.status = status; this.notify(row.sessionId, row.id); };
    }
    fail(frame, error) {
        frame.snapshot.status = 'failed';
        frame.snapshot.error = error instanceof Error ? error.message : '请求失败';
        this.notify(frame.snapshot.sessionId, frame.snapshot.id);
    }
    preparationFailed(sessionId, error) {
        const frame = this.begin(sessionId, {});
        this.bytes -= frame.snapshot.bytes;
        frame.snapshot.bytes = 0;
        frame.snapshot.raw = undefined;
        frame.snapshot.unavailable = '准备失败，未发送';
        this.fail(frame, error);
    }
    complete(frame) {
        if (frame.snapshot.source === 'adapter-input' && frame.snapshot.status !== 'failed') {
            frame.snapshot.status = 'unconfirmed';
            this.notify(frame.snapshot.sessionId, frame.snapshot.id);
        }
    }
    read(sessionId, id) {
        const rows = [...this.rows.values()].filter(row => row.sessionId === sessionId);
        const row = id ? rows.find(item => item.id === id) : rows.at(-1);
        if (!row)
            return null;
        const { origins, bytes, debug, ...safe } = row;
        let body;
        try {
            body = row.raw ? JSON.parse(row.raw) : undefined;
        }
        catch { }
        return { ...safe, warnings: debug?.warnings ?? [], promptRegex: debug?.promptRegex, messages: body ? previewMessages(body, origins) : [],
            choices: rows.map(({ id, at, source, attempt, requestNo, status }) => ({ id, at, source, attempt, requestNo, status })) };
    }
    subscribe(sessionId, callback, close) {
        const lease = { sessionId, callback, close };
        this.listeners.add(lease);
        return () => { this.listeners.delete(lease); };
    }
    close() { for (const lease of this.listeners)
        lease.close(); this.listeners.clear(); this.rows.clear(); this.bytes = 0; }
}
/** Kept separate from wire JSON; uncertain/mixed source messages stay visible. */
export function previewMessages(body, origins = []) {
    const messages = [];
    const used = new Set();
    if (body.system !== undefined)
        messages.push({ role: 'system', content: [{ type: 'text', text: typeof body.system === 'string' ? body.system : JSON.stringify(body.system, null, 2) }], previewHistory: false });
    const rows = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    for (const m of rows) {
        const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [{ type: 'text', text: JSON.stringify(m.content ?? '') }];
        const plain = content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
        const found = origins.findIndex((o, i) => !used.has(i) && o.role === m.role && o.hash === hash(plain));
        if (found >= 0)
            used.add(found);
        const extra = Object.fromEntries(Object.entries(m).filter(([key]) => !['role', 'content', 'source', 'id'].includes(key)));
        messages.push({ ...m, role: m.role ?? 'unknown', content: [...content, ...(Object.keys(extra).length ? [{ type: 'wire-fields', text: JSON.stringify(extra, null, 2) }] : [])],
            previewHistory: m.previewHistory === true || (m.source?.kind === 'user' || m.source?.kind === 'tool') || (found >= 0 && origins[found].history) });
    }
    return messages;
}
/** Iteration runs inside ALS too, so concurrent generators with identical text cannot mix traces. */
export async function* traceRequest(store, sessionId, options, source, debug) {
    const frame = store.begin(sessionId, options, debug), iterator = source[Symbol.asyncIterator]();
    try {
        for (;;) {
            const next = await context.run(frame, () => iterator.next());
            if (next.done)
                break;
            const event = next.value;
            if (event?.type === 'finish' && ['error', 'aborted'].includes(event.reason?.kind ?? ''))
                store.fail(frame, new Error(event.reason?.failure?.message ?? '接口请求未完成'));
            yield next.value;
        }
        store.complete(frame);
    }
    catch (error) {
        store.fail(frame, error);
        throw error;
    }
    finally {
        if (iterator.return)
            await context.run(frame, () => iterator.return());
    }
}
/** Called after all plugin rewrites, immediately before the transport. Does not read streams. */
export function captureOutgoingRequest(input, init) {
    const frame = context.getStore();
    if (!frame)
        return;
    const observation = detectProtocol(input, init);
    if (observation.method !== 'POST' || observation.protocol === 'unknown' || (observation.sessionId && observation.sessionId !== frame.snapshot.sessionId))
        return;
    const body = init?.body;
    if (typeof body !== 'string')
        return;
    return frame.store.wire(frame, body, observation.protocol);
}
