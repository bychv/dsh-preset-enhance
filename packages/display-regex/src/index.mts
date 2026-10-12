import { readFile } from 'node:fs/promises';
export const name = 'preset-display-regex';
export const inject = ['webServer'];
interface Response {
  writeHead(code: number, headers?: Record<string, string>): void;
  end(data?: string | Buffer): void;
}
interface Context {
  effect(fn: () => void | (() => void), label?: string): void;
  webServer: { register(route: {
    kind: string; path: string;
    handler(req: { method?: string }, res: Response): Promise<void> | void;
  }): void | (() => void) };
}
export function apply(ctx: Context) {
  const files = ['runtime.mjs', 'executor.mjs', 'worker.js',
    ...['display-regex', 'prompt-regex', 'macros', 'compaction'].map(n => 'regex/' + n + '.mjs')];
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
      res.end('{"apiVersion":1}');
    },
  }), 'preset-display: status');
}
