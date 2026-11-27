import { AsyncLocalStorage } from 'node:async_hooks';
export const REQUEST_USER_AGENT_PATTERN = /^[\x20-\x7e]*$/u;
const key = Symbol.for('dsh-preset-enhance.request-options');
const globals = globalThis;
const context = globals[key] ??= new AsyncLocalStorage();
/** Snapshot settings for one model stream and its transport retries. */
export async function* withRequestOptions(setting, safetyCheck, source, extra = {}) {
    const existing = context.getStore();
    if (existing?.active) {
        if (!existing.sessionId && extra.sessionId)
            existing.sessionId = extra.sessionId;
        yield* source();
        return;
    }
    const raw = typeof setting === 'string' ? setting : setting?.get();
    if (raw !== undefined && !REQUEST_USER_AGENT_PATTERN.test(raw))
        throw new Error('模型请求 User-Agent 只能包含可打印的 ASCII 字符');
    const userAgent = raw?.trim();
    const scope = {
        userAgent,
        safetyCheck,
        stripHarnessHeaders: extra.stripHarnessHeaders === true,
        sessionId: extra.sessionId,
        active: true,
    };
    const iterator = context.run(scope, () => source()[Symbol.asyncIterator]());
    try {
        for (;;) {
            const result = await context.run(scope, () => iterator.next());
            if (result.done)
                break;
            yield result.value;
        }
    }
    finally {
        scope.active = false;
        await iterator.return?.();
    }
}
export function activeSafetyCheck() {
    const scope = context.getStore();
    return scope?.active ? scope.safetyCheck : undefined;
}
export function activeSessionId() {
    const scope = context.getStore();
    return scope?.active ? scope.sessionId : undefined;
}
export function isHarnessHeader(name) {
    const lower = name.toLowerCase();
    return lower === 'x-deepseek-harness' || lower.startsWith('x-deepseek-harness-');
}
/** Match Fetch's effective header source while leaving Request, body and options intact. */
export function withUserAgentHeader(input, init) {
    const scope = context.getStore();
    if (!scope?.active || (!scope.userAgent && !scope.stripHarnessHeaders))
        return init;
    const rawHeaders = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (!scope.userAgent && !rawHeaders)
        return init;
    const headers = new Headers(rawHeaders);
    let changed = false;
    if (scope.stripHarnessHeaders) {
        for (const name of [...headers.keys()]) {
            if (isHarnessHeader(name)) {
                headers.delete(name);
                changed = true;
            }
        }
    }
    if (scope.userAgent) {
        headers.set('user-agent', scope.userAgent);
        changed = true;
    }
    return changed ? { ...init, headers } : init;
}
