/** Browser-only preferences; these never participate in preset saves. */
export function rememberDisclosures(root, storage) {
    if (!storage) {
        try {
            storage = window.localStorage;
        }
        catch { /* Keep the page usable. */ }
    }
    const disposers = [];
    for (const panel of root.querySelectorAll('details[data-preset-disclosure]')) {
        const key = 'dsh-preset-enhance:disclosure:' + panel.dataset.presetDisclosure;
        try {
            const saved = storage?.getItem(key);
            if (saved === '1' || saved === '0')
                panel.open = saved === '1';
        }
        catch { }
        let previous = panel.open;
        const onToggle = (event) => {
            if (event.target !== panel || panel.open === previous)
                return;
            previous = panel.open;
            try {
                storage?.setItem(key, panel.open ? '1' : '0');
            }
            catch { }
        };
        panel.addEventListener('toggle', onToggle);
        disposers.push(() => panel.removeEventListener('toggle', onToggle));
    }
    return () => { for (const dispose of disposers)
        dispose(); };
}
if (typeof document !== 'undefined')
    rememberDisclosures(document);
