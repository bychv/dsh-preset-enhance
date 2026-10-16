/** Cached iframes stay loaded: CSS hiding does not emit pagehide/visibilitychange. */
export function observeWorkbenchActivity(notify) {
    if (typeof window === 'undefined') {
        notify(true);
        return () => { };
    }
    const doc = typeof document === 'undefined' ? undefined : document;
    const frame = window.frameElement;
    let attached = frame?.dataset.presetEnhanceActive !== 'false', shown = true;
    let last;
    const update = () => {
        const active = attached && shown && doc?.visibilityState !== 'hidden';
        if (last === active)
            return;
        last = active;
        notify(active);
    };
    const message = (event) => {
        if (event.source !== window.parent || event.origin !== window.location.origin ||
            event.data?.type !== 'preset-enhance:activity' || typeof event.data.active !== 'boolean')
            return;
        attached = event.data.active;
        update();
    };
    const hide = () => { shown = false; update(); };
    const show = () => { shown = true; update(); };
    window.addEventListener('message', message);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', show);
    doc?.addEventListener('visibilitychange', update);
    update();
    return () => {
        window.removeEventListener('message', message);
        window.removeEventListener('pagehide', hide);
        window.removeEventListener('pageshow', show);
        doc?.removeEventListener('visibilitychange', update);
    };
}
