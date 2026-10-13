const SCROLL_IDS = ['used-prompts', 'unused-prompts', 'regex-list', 'tool-tablist', 'tool-group-panels', 'group-list'];
const PREFIX = 'dsh-preset-enhance:scroll:';
/** Keep a viewport snapshot for full navigation and refresh; host view switches retain the iframe. */
export function rememberWorkbenchScroll(root, identity, storage) {
    if (!storage) {
        try {
            storage = window.sessionStorage;
        }
        catch { /* Keep scrolling usable. */ }
    }
    const key = () => PREFIX + identity();
    const scrollRoot = () => root.scrollingElement ?? root.documentElement;
    let timer;
    let frame = 0;
    let restoring = false;
    let stopped = false;
    let preserve = false;
    const save = () => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        const positions = { page: scrollRoot().scrollTop };
        for (const id of SCROLL_IDS) {
            const area = root.getElementById(id);
            if (area)
                positions[id] = area.scrollTop;
        }
        try {
            storage?.setItem(key(), JSON.stringify(positions));
        }
        catch { }
    };
    const onScroll = (event) => {
        const target = event.target;
        if (restoring || stopped || preserve || (target !== root && target !== scrollRoot() &&
            !SCROLL_IDS.some(id => target === root.getElementById(id))))
            return;
        if (timer !== undefined)
            clearTimeout(timer);
        timer = setTimeout(save, 180);
    };
    root.addEventListener('scroll', onScroll, true);
    const onPageHide = () => { if (!preserve)
        save(); };
    window.addEventListener('pagehide', onPageHide);
    let saved;
    try {
        const raw = storage?.getItem(key());
        if (raw)
            saved = JSON.parse(raw);
    }
    catch { }
    if (saved && typeof saved === 'object') {
        const restore = () => {
            if (stopped)
                return;
            restoring = true;
            const areas = [['page', scrollRoot()], ...SCROLL_IDS.map(id => [id, root.getElementById(id)])];
            for (const [name, area] of areas) {
                const position = saved?.[name];
                if (area && typeof position === 'number' && Number.isFinite(position))
                    area.scrollTop = Math.max(0, position);
            }
            restoring = false;
        };
        restore();
        frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(restore); });
    }
    const dispose = (() => {
        stopped = true;
        if (frame)
            window.cancelAnimationFrame(frame);
        if (!preserve)
            save();
        root.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('pagehide', onPageHide);
    });
    dispose.preserveOnNavigation = () => {
        preserve = true;
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    return dispose;
}
