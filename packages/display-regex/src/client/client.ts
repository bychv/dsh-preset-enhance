import type { DisplayContext, RenderModules } from './types.mjs';
declare global { interface Window { __ModuleLoader__: { load(definition: { id: string; factory: (require: (name: string) => unknown) => unknown }): void } } }
window.__ModuleLoader__.load({
  id: 'dsh-preset-display-regex',
  factory: require => {
    const React = require('react') as RenderModules['React'];
    const { createRoot } = require('react-dom/client') as Pick<RenderModules, 'createRoot'>;
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives') as Pick<RenderModules, 'MarkdownText'>;
    return { inject: ['uiConversation'], apply(ctx: DisplayContext) {
      let disposed = false, stop: (() => void) | undefined;
      import('./runtime.mjs').then(({ installDisplay }) => {
        if (!disposed) stop = installDisplay(ctx, { React, createRoot, MarkdownText });
      }).catch(() => console.warn('[preset-display] 正文组件加载失败'));
      ctx.effect(() => () => { disposed = true; stop?.(); }, 'preset-display: cleanup');
    }};
  }
});
