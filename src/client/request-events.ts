import { observeWorkbenchActivity } from './workbench-activity.js';

export function observeRequestEvents(sessionId: string, callbacks: {
  mode(): void; snapshot(id: string): void; pause(): void;
}): () => void {
  let events: EventSource | undefined;
  const close = () => { events?.close(); events = undefined; callbacks.pause(); };
  const dispose = observeWorkbenchActivity(active => {
    if (!active) { close(); return; }
    if (!sessionId || typeof EventSource === 'undefined' || events) return;
    const current = events = new EventSource(`/preset-enhance/api/request-events?sessionId=${encodeURIComponent(sessionId)}`);
    current.addEventListener('mode', () => { if (events === current) callbacks.mode(); });
    current.onmessage = event => {
      if (events !== current) return;
      try { const { id } = JSON.parse(event.data); if (typeof id === 'string' && id) callbacks.snapshot(id); } catch { /* ignore invalid notifications */ }
    };
  });
  return () => { dispose(); close(); };
}
