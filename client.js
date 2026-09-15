window.__ModuleLoader__.load({
  id: 'dsh-preset-enhance',
  factory: require => {
    const React = require('react');
    const LOCK_ATTRIBUTE = 'data-preset-enhance-workbench';
    const LOCK_STYLE_ATTRIBUTE = 'data-preset-enhance-resize-lock';
    let mountedWorkbenches = 0;

    function useDshResizeLock() {
      React.useEffect(() => {
        const root = document.documentElement;
        let style = document.querySelector('style[' + LOCK_STYLE_ATTRIBUTE + ']');
        if (!style) {
          style = document.createElement('style');
          style.setAttribute(LOCK_STYLE_ATTRIBUTE, '');
          style.textContent = 'html[' + LOCK_ATTRIBUTE + '] div[data-side="sidebar"],html[' +
            LOCK_ATTRIBUTE + '] div[data-side="rightbar"]{display:none!important}';
          document.head.appendChild(style);
        }
        mountedWorkbenches++;
        root.setAttribute(LOCK_ATTRIBUTE, '');
        return () => {
          mountedWorkbenches = Math.max(0, mountedWorkbenches - 1);
          if (mountedWorkbenches > 0) return;
          root.removeAttribute(LOCK_ATTRIBUTE);
          style.remove();
        };
      }, []);
    }

    const Frame = props => {
      useDshResizeLock();
      return React.createElement('iframe', {
        title: '预设查看与编辑',
        src: '/preset-enhance?sessionId=' +
          encodeURIComponent(props.sessionId ?? props.injected?.sessionId ?? ''),
        style: { width: '100%', height: '100%', minHeight: '640px', border: 0 },
      });
    };
    const PresetIcon = ({ size = 18 }) => React.createElement('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, React.createElement('path', { d: 'M5 4h14v16H5z' }),
    React.createElement('path', { d: 'M8 8h8M8 12h5M8 16h8' }),
    React.createElement('path', { d: 'M16 11v4M14 13h4' }));
    return { inject: ['slots', 'conversation'], apply(ctx) {
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view', id: 'preset-enhance-editor', order: 25,
        label: '预设', inject: sessionId => ({ sessionId }),
      }, Frame));
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main', key: 'preset-enhance-editor',
      }, Frame));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: 'preset-enhance-editor', order: 30, label: '预设工作台',
      }, PresetIcon));
    } };
  },
});
