window.__ModuleLoader__.load({
    id: 'dsh-preset-enhance',
    factory: (require) => {
        const React = require('react');
        const { Button, Input, IconCheckOutlineRegular, IconSearchOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives');
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
        let composerBlocks;
        const pickerKind = 'preset-enhance-picker';
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
        function PresetPicker({ sessionId }) {
            const modeId = useInputMode(sessionId);
            const [filter, setFilter] = React.useState('');
            const [selection, setSelection] = React.useState(null);
            const [reload, setReload] = React.useState(0);
            const [snapshot, setSnapshot] = React.useState(null);
            const [readError, setReadError] = React.useState(null);
            const [notice, setNotice] = React.useState('');
            const [saving, setSaving] = React.useState(false);
            const pendingSave = React.useRef(false);
            const selectedId = selection?.modeId === modeId ? selection.id : '';
            const query = new URLSearchParams({ picker: '', sessionId, modeId, ...(selectedId ? { presetId: selectedId } : {}) });
            const queryString = query.toString();
            const key = `${reload}:${queryString}`;
            React.useEffect(() => {
                const request = new AbortController();
                void (async () => {
                    try {
                        const response = await fetch('/preset-enhance/api?' + queryString, { signal: request.signal });
                        const data = await response.json();
                        if (!response.ok || data.startupError)
                            throw Error(data.startupError || data.error || '无法读取预设');
                        if (!request.signal.aborted)
                            setSnapshot({ key, data });
                    }
                    catch (error) {
                        if (!request.signal.aborted)
                            setReadError({ key, message: error.message });
                    }
                })();
                return () => request.abort();
            }, [key, queryString]);
            React.useEffect(() => {
                const refresh = () => { if (!document.hidden && !pendingSave.current)
                    setReload(value => value + 1); };
                document.addEventListener('visibilitychange', refresh);
                return () => document.removeEventListener('visibilitychange', refresh);
            }, []);
            const data = snapshot?.data;
            const error = readError?.key === key ? readError.message : '';
            const ready = !!data?.sessionReady && snapshot?.key === key && !saving;
            const candidate = selectedId || data?.presetId;
            const active = data?.presets.find(preset => preset.id === data.presetId);
            const presets = data?.presets.filter(preset => preset.name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
            const preview = snapshot?.key === key ? data?.preview : null;
            async function save(presetId) {
                if (!ready || !data || pendingSave.current)
                    return;
                pendingSave.current = true;
                setSaving(true);
                setNotice('');
                const blocks = composerBlocks;
                const block = { reason: '正在应用预设…' };
                try {
                    if (blocks && !blocks.storeFor(sessionId).getSnapshot())
                        blocks.set(sessionId, block);
                    const response = await fetch('/preset-enhance/api', {
                        method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ action: 'select-session-preset', sessionId, presetId, revision: data.revision }),
                    });
                    const result = await response.json();
                    if (!response.ok)
                        throw Error(result.error || '预设应用失败');
                    for (const scope of ['session', 'main']) {
                        for (const record of keptFrames.get(scope + ':' + sessionId) ?? []) {
                            record.element.contentWindow?.postMessage({ type: 'preset-enhance:binding-changed' }, window.location.origin);
                        }
                    }
                    setSelection(null);
                    setNotice(presetId === null ? '已恢复跟随默认' : '已应用');
                }
                catch (cause) {
                    setNotice(cause.message);
                }
                finally {
                    if (blocks?.storeFor(sessionId).getSnapshot() === block)
                        blocks.set(sessionId);
                    pendingSave.current = false;
                    setReload(value => value + 1);
                    setSaving(false);
                }
            }
            const h = React.createElement;
            return h('section', { className: 'dsh-preset-picker', 'aria-label': '预设选择' }, h('div', { className: 'dsh-preset-picker-header' }, h('div', { className: 'dsh-preset-picker-current' }, h('strong', { title: active?.name }, active?.name ?? (data ? '未选择预设' : '正在加载…')), data && h('small', null, [data.mode, data.explicit ? '本会话' : '默认', data.enabled ? '注入已开启' : '注入已关闭'].filter(Boolean).join(' · '))), h('a', { href: workbenchSrc(sessionId, modeId), target: '_blank', rel: 'noopener' }, '打开工作台')), h(Input, { className: 'dsh-preset-picker-search', value: filter, placeholder: '搜索预设', 'aria-label': '搜索预设',
                icon: h(IconSearchOutlineRegular, null), onChange: (event) => setFilter(event.currentTarget.value) }), h('ul', { className: 'dsh-preset-picker-list', 'aria-label': '预设列表' }, presets?.map(preset => h('li', { key: preset.id }, h(Button, { variant: 'ghost', size: 'sm', 'aria-pressed': candidate === preset.id,
                onClick: () => { setSelection({ modeId, id: preset.id }); setNotice(''); } }, h('span', { title: preset.name }, preset.name), preset.id === data?.presetId && h(IconCheckOutlineRegular, { 'aria-label': '当前预设' }))))), presets?.length === 0 && h('small', null, filter.trim() ? '没有匹配的预设' : '尚未导入预设'), h('div', { className: 'dsh-preset-picker-actions' }, h(Button, { variant: 'primary', size: 'sm', disabled: !ready || !preview || !candidate ||
                    (data?.explicit && data.enabled && candidate === data.presetId), onClick: () => { if (candidate)
                    void save(candidate); } }, '使用此预设'), h(Button, { variant: 'outline', size: 'sm', disabled: !ready || !data?.explicit, onClick: () => { void save(null); } }, '跟随默认')), (saving || error || notice) && h('p', { role: 'status' }, saving ? '正在应用…' : error || notice), error && h(Button, { size: 'sm', variant: 'outline', onClick: () => setReload(value => value + 1) }, '重试'), preview && h('div', { className: 'dsh-preset-picker-preview' }, h('h2', null, '提示词预览'), preview.prefix && h('small', null, '包含助手预填充'), preview.entries.map((entry, index) => renderPickerEntry(entry, index)), preview.prefixText && renderPickerEntry({ name: '助手预填充', role: 'assistant', enabled: true,
                marker: false, dynamic: false, depth: null, text: preview.prefixText }, preview.entries.length)));
        }
        function renderPickerEntry(entry, index) {
            const h = React.createElement;
            const role = { system: '系统', user: '用户', assistant: '助手' }[entry.role] ?? entry.role;
            const meta = [role, entry.enabled ? '' : '停用', entry.dynamic ? '动态模板' : entry.marker ? '标记' : '',
                entry.depth === null ? '' : `深度 ${entry.depth}`].filter(Boolean).join(' · ');
            return h('details', { key: index }, h('summary', null, h('span', null, entry.name), h('small', null, meta)), h('pre', null, entry.text || (entry.marker ? '运行时读取' : '空正文')));
        }
        function RightPicker(props) {
            const sessionId = props.sessionId ?? props.injected?.sessionId ?? '';
            return React.createElement(PresetPicker, { key: sessionId, sessionId });
        }
        function ComposerPicker({ sidebar, ...props }) {
            const sessionId = props.sessionId ?? props.injected?.sessionId;
            const current = React.useSyncExternalStore(listener => sidebar.mounted.subscribe(listener), () => sidebar.mounted.getSnapshot(), () => undefined);
            return React.createElement(Button, { variant: 'ghost', size: 'sm', icon: React.createElement(PresetIcon, { size: 16 }),
                'aria-label': '选择预设', disabled: !sessionId || current !== sessionId,
                onClick: () => { if (sessionId && sidebar.mounted.getSnapshot() === sessionId)
                    sidebar.openTab(pickerKind, { destination: 'sidebar' }); },
            }, '预设');
        }
        return { inject: ['slots', 'conversation'], apply(ctx) {
                hostSlots = ctx.slots;
                composerBlocks = ctx.conversation?.blocks;
                ctx.effect?.(() => clearFrames);
                ctx.inject?.(['slots', 'sidebarRightTabs', 'sidebarRight'], scoped => {
                    const sidebar = scoped.sidebarRight;
                    scoped.effect?.(() => {
                        const stylesheet = document.createElement('link');
                        stylesheet.rel = 'stylesheet';
                        stylesheet.href = '/preset-enhance/preset-picker.css';
                        document.head.appendChild(stylesheet);
                        return () => stylesheet.remove();
                    });
                    scoped.effect?.(() => scoped.sidebarRightTabs.register({
                        id: pickerKind, kind: pickerKind, title: () => '预设',
                        guide: [{ id: pickerKind, title: () => '预设', order: 30, icon: PresetIcon }],
                    }));
                    scoped.slots.inject('sidebar.right.pane.tab', () => scoped.slots.register({
                        name: 'sidebar.right.pane.tab', key: pickerKind,
                    }, RightPicker));
                    scoped.slots.inject('conversation.input.right', () => scoped.slots.register({
                        name: 'conversation.input.right', id: pickerKind, order: 30,
                    }, (props) => React.createElement(ComposerPicker, { ...props, sidebar })));
                });
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
