import { randomUUID } from 'node:crypto';
import { PRESET_DISPLAY_SERVICE, PRESET_DISPLAY_EVENT } from '../../../src/display-api.mjs';
import { readFile } from 'node:fs/promises';
export const name = 'preset-display-regex';
export const inject = ['webServer'];
interface Response {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(data?: string | Buffer): void;
}
interface Context {
  provide(name: string, value: unknown): void;
  emit(name: string, value: unknown): void;
  effect(fn: () => void | (() => void), label?: string): void;
  webServer: { register(route: {
    kind: string; path: string;
    handler(req: { method?: string }, res: Response): Promise<void> | void;
  }): void | (() => void) };
}
export async function apply(ctx: Context) {
  const files = ['runtime.mjs', 'executor.mjs', 'worker.js',
    ...['display-regex', 'prompt-regex', 'macros', 'compaction'].map(n => 'regex/' + n + '.mjs')];
  // Validate shipped resources before advertising the capability.
  await Promise.all(files.map(file => readFile(new URL(file, import.meta.url))));
  const capability = { apiVersion: 1 as const, instance: randomUUID(), ready: false };
  ctx.provide(PRESET_DISPLAY_SERVICE, capability);
  for (const file of files) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/preset-enhance-display/' + file,
    handler: async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const body = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    },
  }), 'preset-display: asset');
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/preset-enhance-display/status',
    handler: (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(capability));
    },
  }), 'preset-display: status');
  ctx.effect(() => {
    capability.ready = true;
    ctx.emit(PRESET_DISPLAY_EVENT, capability);
    return () => { capability.ready = false; ctx.emit(PRESET_DISPLAY_EVENT, capability); };
  }, 'preset-display: availability');
}
