import type { DisplayAvailability } from '../display-api.mjs';
export type DisplayStatus = DisplayAvailability;
const off: DisplayStatus = { apiVersion: 1, available: false, instance: null };
const displayListeners = new Set<(status: DisplayStatus) => void>();
const templateListeners = new Set<() => void>();
let status = off, revision: number | undefined, stop: (() => void) | undefined;
function publish(data: unknown) {
  if (!data || typeof data !== 'object' || !('apiVersion' in data) || data.apiVersion !== 1) status = off;
  else {
    const value = data as Partial<DisplayStatus>;
    status = { apiVersion: 1, available: value.available === true, instance: typeof value.instance === 'string' ? value.instance : null };
  }
  for (const notify of displayListeners) notify(status);
}
function connect() {
  if (stop) return;
  let closed = false, epoch = 0;
  const abort = new AbortController();
  const events = new EventSource('/preset-enhance/api/template-events');
  stop = () => { closed = true; abort.abort(); events.close(); };
  events.onmessage = event => {
    if (closed) return;
    ++epoch;
    try {
      const value = JSON.parse(event.data) as { display?: unknown; revision?: number };
      publish(value.display);
      if (typeof value.revision === 'number' && value.revision !== revision) {
        revision = value.revision; for (const notify of templateListeners) notify();
      }
    } catch { publish(off); }
  };
  events.onerror = () => { ++epoch; if (!closed) publish(off); };
  const generation = epoch;
  void fetch('/preset-enhance/api/display-status', { signal: abort.signal }).then(async response => {
    if (!response.ok) throw new Error('Unavailable');
    const value: unknown = await response.json();
    if (!closed && epoch === generation) publish(value);
  }).catch(() => { if (!closed && epoch === generation) publish(off); });
}
function release() {
  if (displayListeners.size || templateListeners.size) return;
  stop?.(); stop = undefined; status = off; revision = undefined;
}
function lease(start: () => void, end: () => void): () => void {
  let active = false, disposed = false;
  const resume = () => { if (disposed || active) return; active = true; start(); connect(); };
  const pause = () => { if (!active) return; active = false; end(); release(); };
  if (typeof window !== 'undefined') { window.addEventListener('pageshow', resume); window.addEventListener('pagehide', pause); }
  resume();
  return () => {
    disposed = true; pause();
    if (typeof window !== 'undefined') { window.removeEventListener('pageshow', resume); window.removeEventListener('pagehide', pause); }
  };
}
export function observeDisplayAvailability(notify: (status: DisplayStatus) => void): () => void {
  const listener = (value: DisplayStatus) => notify(value);
  return lease(() => { displayListeners.add(listener); notify(status); }, () => displayListeners.delete(listener));
}
export function observeTemplateEvents(notify: () => void): () => void {
  const listener = () => notify();
  return lease(() => templateListeners.add(listener), () => templateListeners.delete(listener));
}
