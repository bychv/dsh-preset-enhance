window.__ModuleLoader__.load({
    id: 'dsh-preset-enhance',
    factory: (require) => {
        const React = require('react');
        const LOCK_STYLE_ATTRIBUTE = 'data-preset-enhance-resize-lock';
        const LOCK_STATE_KEY = '__dshPresetEnhanceResizeLock';
        const WORKBENCH_TITLE = '预设查看与编辑';
        const FRAME_STYLE = { width: '100%', height: '100%', minHeight: '640px', border: 0 };
        function lockState() {
            const host = window;
            const existing = host[LOCK_STATE_KEY];
            if (existing && typeof existing === 'object' && existing.owners instanceof Set)
                return existing;
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
                document.head.appendChild(style);
            }
            style.textContent = '[data-conversation-content]:has([data-preset-enhance-frame-host]) > [data-width-handle]{display:none!important}';
            state.style = style;
        }
        function releaseResizeLock(token) {
            const state = lockState();
            state.owners.delete(token);
            if (state.owners.size > 0)
                return;
            if (state.style && state.style.isConnected !== false)
                state.style.remove();
            state.style = null;
        }
        function useDshResizeLock() {
            React.useEffect(() => {
                const token = {};
                lockState().owners.add(token);
                applyResizeLock();
                return () => releaseResizeLock(token);
            }, []);
        }
        let hostSlots;
        const keptFrames = new Map();
        const MAX_PARKED_FRAMES = 4;
        const workbenchSrc = (sessionId, modeId = '') => '/preset-enhance?sessionId=' + encodeURIComponent(sessionId) +
            (!sessionId && modeId ? '&modeId=' + encodeURIComponent(modeId) : '');
        const noSubscribe = () => () => { };
        function useInputMode(sessionId) {
            const key = 'conversation.hero.agentPreset';
            const entryOf = () => (hostSlots?.entriesOfSlot?.(key) ?? hostSlots?.entries?.(key) ?? [])[0];
            const entry = React.useSyncExternalStore(listener => hostSlots?.subscribe?.(key, listener) ?? noSubscribe(), entryOf, entryOf);
            // Read the same public slot face used by DSH's mode chip. Do not select a mode.
            const face = entry?.inject?.(sessionId || undefined);
            const source = face?.hooks?.agentPresetSeat;
            const read = () => source?.getSnapshot?.().current ?? '';
            const modeId = React.useSyncExternalStore(source ? listener => source.subscribe(listener) : noSubscribe, read, read);
            React.useEffect(() => { if (source && !read())
                void face.load?.(); }, [entry, source]);
            return modeId;
        }
        function notifyFrameActivity(record, active) {
            record.element.setAttribute('data-preset-enhance-active', String(active));
            record.element.contentWindow?.postMessage({ type: 'preset-enhance:activity', active }, window.location.origin);
        }
        function acquireFrame(key, src) {
            const candidates = keptFrames.get(key) ?? [];
            let record = candidates.find(item => !item.active && item.element.isConnected);
            if (!record) {
                const element = document.createElement('iframe');
                element.title = WORKBENCH_TITLE;
                element.src = src;
                element.style.position = 'fixed';
                element.style.border = '0';
                element.style.visibility = 'hidden';
                element.style.pointerEvents = 'none';
                element.style.left = '-10000px';
                element.style.top = '-10000px';
                element.style.zIndex = '3';
                document.body.appendChild(element);
                record = { element, active: false, lastUsed: 0 };
                candidates.push(record);
                keptFrames.set(key, candidates);
            }
            record.active = true;
            record.element.setAttribute('data-preset-enhance-frame', '');
            record.element.removeAttribute('aria-hidden');
            return record;
        }
        function parkFrame(record) {
            record.active = false;
            record.lastUsed = Date.now();
            const frame = record.element;
            notifyFrameActivity(record, false);
            frame.removeAttribute('data-preset-enhance-frame');
            frame.setAttribute('aria-hidden', 'true');
            frame.style.visibility = 'hidden';
            frame.style.pointerEvents = 'none';
            frame.style.left = '-10000px';
            frame.style.top = '-10000px';
            const parked = [...keptFrames.values()].flat().filter(item => !item.active).sort((a, b) => a.lastUsed - b.lastUsed);
            for (const stale of parked.slice(0, Math.max(0, parked.length - MAX_PARKED_FRAMES))) {
                stale.element.remove();
                for (const [key, entries] of keptFrames) {
                    const index = entries.indexOf(stale);
                    if (index >= 0) {
                        entries.splice(index, 1);
                        if (!entries.length)
                            keptFrames.delete(key);
                        break;
                    }
                }
            }
        }
        function clearFrames() {
            for (const entries of keptFrames.values())
                for (const item of entries)
                    item.element.remove();
            keptFrames.clear();
        }
        function useWorkbenchFrame({ sessionId = '', modeId = '' }, kind) {
            const holder = React.useRef(null);
            const current = React.useRef(null);
            const selectedMode = React.useRef(modeId);
            selectedMode.current = modeId;
            React.useEffect(() => {
                const anchor = holder.current;
                if (!anchor)
                    return;
                const record = acquireFrame(kind + ':' + sessionId, workbenchSrc(sessionId, selectedMode.current));
                current.current = record;
                const frame = record.element;
                const notify = () => {
                    notifyFrameActivity(record, record.active);
                    frame.contentWindow?.postMessage({ type: 'preset-enhance:input-mode', modeId: selectedMode.current }, window.location.origin);
                };
                const position = () => {
                    if (!anchor.isConnected)
                        return;
                    const rect = anchor.getBoundingClientRect();
                    const scrollport = anchor.closest('[data-conversation-scroll]');
                    const bounds = scrollport?.getBoundingClientRect() ?? { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
                    frame.style.left = rect.left + 'px';
                    frame.style.top = rect.top + 'px';
                    frame.style.width = rect.width + 'px';
                    frame.style.height = rect.height + 'px';
                    frame.style.clipPath = `inset(${Math.max(0, bounds.top - rect.top)}px ${Math.max(0, rect.right - bounds.right)}px ${Math.max(0, rect.bottom - bounds.bottom)}px ${Math.max(0, bounds.left - rect.left)}px)`;
                    frame.style.visibility = rect.width > 0 && rect.height > 0 ? 'visible' : 'hidden';
                    frame.style.pointerEvents = frame.style.visibility === 'visible' ? 'auto' : 'none';
                };
                frame.addEventListener('load', notify);
                window.addEventListener('resize', position);
                window.addEventListener('scroll', position, true);
                const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
                observer?.observe(anchor);
                position();
                notify();
                return () => {
                    observer?.disconnect();
                    window.removeEventListener('resize', position);
                    window.removeEventListener('scroll', position, true);
                    frame.removeEventListener('load', notify);
                    current.current = null;
                    parkFrame(record);
                };
            }, [sessionId, kind]);
            React.useEffect(() => {
                current.current?.element.contentWindow?.postMessage({ type: 'preset-enhance:input-mode', modeId }, window.location.origin);
            }, [sessionId, modeId]);
            return React.createElement('div', { ref: holder, style: FRAME_STYLE, 'data-preset-enhance-frame-host': '' });
        }
        /**
         * Session-scoped workbench. `conversation.view` is declared with
         * `scope: 'session'` (ui-conversation/src/client/contract/slots.ts), so the
         * host always hands the rendered occurrence its own `props.sessionId` — the
         * conversation the user is looking at, including a sidebar child session.
         * There is deliberately no `useSessions.current` fallback here: that hook
         * resolves the MAIN view, so falling back to it would let editing a child
         * session write the main session's binding and tool overrides.
         */
        const SessionFrame = (props) => {
            useDshResizeLock();
            const sessionId = props.sessionId ?? props.injected?.sessionId ?? '';
            const modeId = useInputMode(sessionId);
            const frame = useWorkbenchFrame({ sessionId, modeId }, 'session');
            if (!sessionId) {
                return React.createElement('p', { className: 'muted' }, '未识别当前会话，暂不能编辑会话级设置；请从会话视图或侧边栏面板打开预设工作台。');
            }
            return frame;
        };
        /**
         * Root-scope workbench, addressed by the sidebar panel id. `main` is a
         * root-scoped keyed slot (ui-sidebar/README.zh.md), so this occurrence gets no
         * sessionId. Current DSH marks the main-view Session via retainedBy.mainView;
         * older hosts expose current directly. A host-provided sessionId still wins.
         */
        const MainPanelFrame = (props) => {
            useDshResizeLock();
            const currentSessionId = typeof props.useSessions === 'function'
                ? props.useSessions(state => Object.values(state.byId ?? {}).find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id ?? state.current)
                : undefined;
            const sessionId = props.sessionId ?? props.injected?.sessionId ?? currentSessionId ?? '';
            const modeId = useInputMode(sessionId);
            return useWorkbenchFrame({ sessionId, modeId }, 'main');
        };
        const PresetIcon = ({ size = 18 }) => React.createElement('svg', {
            width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
            strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, React.createElement('path', { d: 'M5 4h14v16H5z' }), React.createElement('path', { d: 'M8 8h8M8 12h5M8 16h8' }), React.createElement('path', { d: 'M16 11v4M14 13h4' }));
        return { inject: ['slots', 'conversation'], apply(ctx) {
                hostSlots = ctx.slots;
                ctx.effect?.(() => clearFrames);
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
