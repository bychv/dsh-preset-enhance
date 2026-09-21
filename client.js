window.__ModuleLoader__.load({
  id: 'dsh-preset-enhance',
  factory: require => {
    const React = require('react');
    const LOCK_ATTRIBUTE = 'data-preset-enhance-workbench';
    const LOCK_STYLE_ATTRIBUTE = 'data-preset-enhance-resize-lock';
    // The lock bookkeeping lives on `window` on purpose. The client module loader
    // invalidates and re-materializes this factory on plugin reload / code
    // replacement (packages/client/modules/src/client/entries.ts -> replace()), so
    // a closure-local counter would restart at zero while an older instance's
    // cleanup could still remove the shared <style>. One shared record keeps
    // repeated enable/disable and reload balanced; the owner Set is idempotent.
    const LOCK_STATE_KEY = '__dshPresetEnhanceResizeLock';
    const WORKBENCH_TITLE = '预设查看与编辑';
    const FRAME_STYLE = { width: '100%', height: '100%', minHeight: '640px', border: 0 };

    function lockState() {
      const host = window;
      const existing = host[LOCK_STATE_KEY];
      if (existing && typeof existing === 'object' && existing.owners instanceof Set) return existing;
      const created = { owners: new Set(), style: null };
      host[LOCK_STATE_KEY] = created;
      return created;
    }
    function applyResizeLock() {
      const state = lockState();
      let style = document.querySelector('style[' + LOCK_STYLE_ATTRIBUTE + ']');
      if (!style) {
        style = document.createElement('style');
        style.setAttribute(LOCK_STYLE_ATTRIBUTE, '');
        style.textContent = 'html[' + LOCK_ATTRIBUTE + '] div[data-side="sidebar"],html[' +
          LOCK_ATTRIBUTE + '] div[data-side="rightbar"]{display:none!important}';
        document.head.appendChild(style);
      }
      state.style = style;
      document.documentElement.setAttribute(LOCK_ATTRIBUTE, '');
    }
    function releaseResizeLock(token) {
      const state = lockState();
      state.owners.delete(token);
      if (state.owners.size > 0) return;
      if (state.style && state.style.isConnected !== false) state.style.remove();
      state.style = null;
      document.documentElement.removeAttribute(LOCK_ATTRIBUTE);
    }
    function useDshResizeLock() {
      React.useEffect(() => {
        const token = {};
        lockState().owners.add(token);
        applyResizeLock();
        return () => releaseResizeLock(token);
      }, []);
    }

    const workbenchSrc = sessionId => '/preset-enhance?sessionId=' + encodeURIComponent(sessionId);
    /**
     * Session-scoped workbench. `conversation.view` is declared with
     * `scope: 'session'` (ui-conversation/src/client/contract/slots.ts), so the
     * host always hands the rendered occurrence its own `props.sessionId` — the
     * conversation the user is looking at, including a sidebar child session.
     * There is deliberately no `useSessions.current` fallback here: that hook
     * resolves the MAIN view, so falling back to it would let editing a child
     * session write the main session's binding and tool overrides.
     */
    const SessionFrame = props => {
      useDshResizeLock();
      const sessionId = props.sessionId ?? props.injected?.sessionId ?? '';
      if (!sessionId) {
        return React.createElement('p', { className: 'muted' },
          '未识别当前会话，暂不能编辑会话级设置；请从会话视图或侧边栏面板打开预设工作台。');
      }
      return React.createElement('iframe', { title: WORKBENCH_TITLE, src: workbenchSrc(sessionId), style: FRAME_STYLE });
    };
    /**
     * Root-scope workbench, addressed by the sidebar panel id. `main` is a
     * root-scoped keyed slot (ui-sidebar/README.zh.md), so this occurrence gets no
     * sessionId and `useSessions.current` — the host's main-view binding — is the
     * only session source. A host-provided sessionId still wins when present.
     */
    const MainPanelFrame = props => {
      useDshResizeLock();
      const currentSessionId = typeof props.useSessions === 'function'
        ? props.useSessions(state => state.current)
        : undefined;
      const sessionId = props.sessionId ?? props.injected?.sessionId ?? currentSessionId ?? '';
      return React.createElement('iframe', { title: WORKBENCH_TITLE, src: workbenchSrc(sessionId), style: FRAME_STYLE });
    };
    const PresetIcon = ({ size = 18 }) => React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, React.createElement('path', { d: 'M5 4h14v16H5z' }),
    React.createElement('path', { d: 'M8 8h8M8 12h5M8 16h8' }),
    React.createElement('path', { d: 'M16 11v4M14 13h4' }));
    return { inject: ['slots', 'conversation'], apply(ctx) {
      // Every registration is fiber-scoped: slots.inject()/register() run through
      // the caller's ctx.effect (ui-renderer/src/client/registry.ts), and the loader
      // disposes the entry fiber on disable/removal and re-materializes the factory
      // on reload. One registration per apply, released with the fiber, is what keeps
      // sidebar buttons, editors and the resize lock from accumulating.
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'preset-enhance-editor', order: 25,
        label: '预设',
      }, SessionFrame));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'preset-enhance-editor',
      }, MainPanelFrame));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'preset-enhance-editor', order: 30, label: '预设工作台',
      }, PresetIcon));
    } };
  },
});
