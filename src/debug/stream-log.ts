/**
 * Streams load/debug events to the dev server.
 *
 * Each event is one JSON line: when it happened, the JS heap, and whatever
 * the caller attached (page, phase, texture MB). The Vite middleware appends
 * those lines to debug-stream.log and prints them in the dev terminal.
 * A production build has no middleware; the POST fails quietly.
 *
 * Restart the dev server after this file's plugin lands, or the headset
 * POSTs go nowhere.
 */

interface Memory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

type Detail = Record<string, unknown>;

const queue: string[] = [];
let timer = 0;
let lastStallAt = 0;
let worstStall = 0;

function heap(): { heapMB: number | null; heapLimitMB: number | null } {
  const m = (performance as Performance & { memory?: Memory }).memory;
  if (!m) return { heapMB: null, heapLimitMB: null };
  return {
    heapMB: Math.round(m.usedJSHeapSize / 1048576),
    heapLimitMB: Math.round(m.jsHeapSizeLimit / 1048576),
  };
}

function endpoint(): string {
  return `${location.origin}/__debug/stream`;
}

function flush(): void {
  if (timer) {
    window.clearTimeout(timer);
    timer = 0;
  }
  if (queue.length === 0) return;
  const body = queue.splice(0, queue.length).join('\n');
  const url = endpoint();
  try {
    if (document.visibilityState === 'hidden' && navigator.sendBeacon?.(url, body)) return;
  } catch {
    /* fetch below */
  }
  void fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body,
    keepalive: true,
  }).catch(() => {
    /* dev server not restarted yet, or a production build */
  });
}

/** Record one streaming/debug event. Safe to call from the load path. */
export function streamLog(event: string, detail?: Detail): void {
  const row = { t: Math.round(performance.now()), event, ...heap(), ...(detail ? { detail } : {}) };
  queue.push(JSON.stringify(row));
  if (queue.length > 400) queue.splice(0, queue.length - 400);
  // Enter/fail/stall go out now, so a freeze afterwards still left a mark.
  const urgent = event.endsWith('.enter') || event.endsWith('.fail') || event.endsWith('.cancel') || event === 'frame.stall';
  if (urgent) flush();
  else if (!timer) timer = window.setTimeout(flush, 400);
}

/** Call once per frame. Logs at most one stall a second while frames are slow. */
export function noteFrame(dt: number): void {
  if (dt < 0.1) return;
  worstStall = Math.max(worstStall, dt);
  const now = performance.now();
  if (now - lastStallAt < 1000) return;
  lastStallAt = now;
  const dtMs = Math.round(worstStall * 1000);
  worstStall = 0;
  streamLog('frame.stall', { dtMs });
}

window.addEventListener('pagehide', flush);
