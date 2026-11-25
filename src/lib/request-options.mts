import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginConfig } from '../host-types.mjs';
import type { DeepSeekSafetyCheckLevel } from './types.mjs';

export const REQUEST_USER_AGENT_PATTERN = /^[\x20-\x7e]*$/u;

type RequestScope = { userAgent: string | undefined; safetyCheck: DeepSeekSafetyCheckLevel; active: boolean };
const key = Symbol.for('dsh-preset-enhance.request-options');
const globals = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>;
const context = globals[key] ??= new AsyncLocalStorage<RequestScope>();

/** Snapshot settings for one model stream and its transport retries. */
export async function* withRequestOptions(setting: PluginConfig['requestUserAgent'], safetyCheck: DeepSeekSafetyCheckLevel, source: () => AsyncIterable<unknown>) {
  if (context.getStore()?.active) { yield* source(); return; }
  const raw = typeof setting === 'string' ? setting : setting?.get();
  if (raw !== undefined && !REQUEST_USER_AGENT_PATTERN.test(raw)) throw new Error('模型请求 User-Agent 只能包含可打印的 ASCII 字符');
  const userAgent = raw?.trim();
  const scope = { userAgent, safetyCheck, active: true };
  const iterator = context.run(scope, () => source()[Symbol.asyncIterator]());
  try {
    for (;;) {
      const result = await context.run(scope, () => iterator.next());
      if (result.done) break;
      yield result.value;
    }
  } finally {
    scope.active = false;
    await iterator.return?.();
  }
}

export function activeSafetyCheck(): DeepSeekSafetyCheckLevel | undefined {
  const scope = context.getStore();
  return scope?.active ? scope.safetyCheck : undefined;
}

/** Match Fetch's effective header source while leaving Request, body and options intact. */
export function withUserAgentHeader(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  const scope = context.getStore();
  if (!scope?.active || !scope.userAgent) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('user-agent', scope.userAgent);
  return { ...init, headers };
}
