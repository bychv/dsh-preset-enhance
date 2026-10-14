type ScrollStorage = Pick<Storage, 'getItem' | 'setItem'>;

const SCROLL_IDS = ['used-prompts', 'unused-prompts', 'regex-list', 'tool-tablist', 'tool-group-panels', 'group-list'];
const PREFIX = 'dsh-preset-enhance:scroll:';
type ScrollController = (() => void) & { preserveOnNavigation(): void };

/** Keep a viewport snapshot for full navigation and refresh; host view switches retain the iframe. */
export function rememberWorkbenchScroll(root: Document, identity: () => string, storage?: ScrollStorage): ScrollController {
  if (!storage) { try { storage = window.sessionStorage; } catch { /* Keep scrolling usable. */ } }
  const key = () => PREFIX + identity();
  const scrollRoot = () => root.scrollingElement ?? root.documentElement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let restoring = false;
  let stopped = false;
  let preserve = false;

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
    if (restoring || stopped || preserve || (target !== root && target !== scrollRoot() &&
      !SCROLL_IDS.some(id => target === root.getElementById(id)))) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, 180);
  };
  root.addEventListener('scroll', onScroll, true);
  const onPageHide = () => { if (!preserve) save(); };
  window.addEventListener('pagehide', onPageHide);
  // A canceled beforeunload leaves this document alive; resume on further input.
  // pageshow also covers returning through the browser's back-forward cache.
  const resume = () => { preserve = false; };
  const inputEvents = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
  for (const name of inputEvents) root.addEventListener(name, resume, true);
  window.addEventListener('pageshow', resume);

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

  const dispose = (() => {
    stopped = true;
    if (frame) window.cancelAnimationFrame(frame);
    if (!preserve) save();
    root.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', resume);
    for (const name of inputEvents) root.removeEventListener(name, resume, true);
  }) as ScrollController;
  dispose.preserveOnNavigation = () => {
    preserve = true;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
  };
  return dispose;
}
