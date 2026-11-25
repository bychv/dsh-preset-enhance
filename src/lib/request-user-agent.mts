import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginConfig } from '../host-types.mjs';

export const REQUEST_USER_AGENT_PATTERN = /^[\x20-\x7e]*$/u;

type RequestScope = { value: string; active: boolean };
const key = Symbol.for('dsh-preset-enhance.request-user-agent');
const globals = globalThis as unknown as Record<symbol, AsyncLocalStorage<RequestScope> | undefined>;
const context = globals[key] ??= new AsyncLocalStorage<RequestScope>();

/** Carry one settings value through this model stream and its transport retries. */
export async function* withRequestUserAgent(setting: PluginConfig['requestUserAgent'], source: () => AsyncIterable<unknown>) {
  if (context.getStore()?.active) { yield* source(); return; }
  const raw = typeof setting === 'string' ? setting : setting?.get();
  if (raw !== undefined && !REQUEST_USER_AGENT_PATTERN.test(raw)) throw new Error('模型请求 User-Agent 只能包含可打印的 ASCII 字符');
  const value = raw?.trim();
  if (!value) { yield* source(); return; }

  const scope = { value, active: true };
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

/** Match Fetch's effective header source while leaving Request, body and options intact. */
export function withUserAgentHeader(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) {
  const scope = context.getStore();
  if (!scope?.active) return init;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set('user-agent', scope.value);
  return { ...init, headers };
}
