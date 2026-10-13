type ScrollStorage = Pick<Storage, 'getItem' | 'setItem'>;

const SCROLL_IDS = ['used-prompts', 'unused-prompts', 'regex-list', 'tool-tablist', 'tool-group-panels', 'group-list'];
const PREFIX = 'dsh-preset-enhance:scroll:';

/** The workbench iframe is recreated when its host view changes. Keep its viewport locally. */
export function rememberWorkbenchScroll(root: Document, identity: () => string, storage?: ScrollStorage): () => void {
  if (!storage) { try { storage = window.sessionStorage; } catch { /* Keep scrolling usable. */ } }
  const key = () => PREFIX + identity();
  const scrollRoot = () => root.scrollingElement ?? root.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let restoring = false;
  let stopped = false;

  const save = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const positions: Record<string, number> = { page: scrollRoot().scrollTop };
    for (const id of SCROLL_IDS) {
      const area = root.getElementById(id);
      if (area) positions[id] = area.scrollTop;
    }
    try { storage?.setItem(key(), JSON.stringify(positions)); } catch {}
  };
  const onScroll = (event: Event) => {
    const target = event.target;
    if (restoring || stopped || (target !== root && target !== scrollRoot() &&
      !SCROLL_IDS.some(id => target === root.getElementById(id)))) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, 180);
  };
  root.addEventListener('scroll', onScroll, true);
  const onPageHide = () => save();
  window.addEventListener('pagehide', onPageHide);

  let saved: Record<string, unknown> | undefined;
  try {
    const raw = storage?.getItem(key());
    if (raw) saved = JSON.parse(raw) as Record<string, unknown>;
  } catch {}
  if (saved && typeof saved === 'object') {
    const restore = () => {
      if (stopped) return;
      restoring = true;
      const areas: Array<[string, Element | null]> = [['page', scrollRoot()], ...SCROLL_IDS.map(id => [id, root.getElementById(id)] as [string, Element | null])];
      for (const [name, area] of areas) {
        const position = saved?.[name];
        if (area && typeof position === 'number' && Number.isFinite(position)) area.scrollTop = Math.max(0, position);
      }
      restoring = false;
    };
    restore();
    frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(restore); });
  }

  return () => {
    stopped = true;
    if (frame) window.cancelAnimationFrame(frame);
    save();
    root.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', onPageHide);
  };
}
