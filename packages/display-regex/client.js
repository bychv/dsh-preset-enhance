window.__ModuleLoader__.load({
  id: 'dsh-preset-display-regex',
  factory: require => {
    const React = require('react');
    const { createRoot } = require('react-dom/client');
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives');
    return { inject: ['uiConversation'], apply(ctx) {
      let disposed = false, stop;
      import('/preset-enhance-display/runtime.mjs').then(({ installDisplay }) => {
        if (!disposed) stop = installDisplay(ctx, { React, createRoot, MarkdownText });
      }).catch(() => console.warn('[preset-display] 正文组件加载失败'));
      ctx.effect(() => () => { disposed = true; stop?.(); }, 'preset-display: cleanup');
    }};
  }
});
