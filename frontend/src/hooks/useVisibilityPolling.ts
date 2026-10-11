import { useEffect } from 'react';

// Runs callback once on mount, then on an interval while the tab is
// visible. A hidden (backgrounded) tab stops the interval entirely —
// browsers throttle timers there anyway, and polling an unseen dashboard
// is wasted load on the agent. On return to the foreground the callback
// fires immediately so the UI catches up before the next tick.
export function useVisibilityPolling(callback: () => void, intervalMs: number): void {
  useEffect(() => {
    callback();
    let id: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (id !== null) {
        clearInterval(id);
        id = null;
      }
    };
    const start = () => {
      if (id === null) id = setInterval(callback, intervalMs);
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        callback();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [callback, intervalMs]);
}
