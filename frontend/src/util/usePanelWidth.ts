import { useCallback, useEffect, useState } from 'react';

export const MIN_PANEL_WIDTH = 480;
export const DEFAULT_PANEL_WIDTH = 640;
export const STORAGE_KEY = 'muti-metroo-manager.agent-panel-width';
const CSS_VAR = '--agent-panel-width';

export function maxPanelWidth(viewportWidth: number): number {
  return Math.floor(viewportWidth * 0.8);
}

// When the viewport is too narrow for the 480 floor (vw <= 600px), the
// viewport-derived max wins. On a tiny screen the panel may be smaller
// than the nominal min, which is preferable to spilling off-screen.
function clampWidth(n: number, viewportWidth: number): number {
  const max = maxPanelWidth(viewportWidth);
  if (max < MIN_PANEL_WIDTH) return Math.max(0, Math.min(n, max));
  return Math.max(MIN_PANEL_WIDTH, Math.min(n, max));
}

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return DEFAULT_PANEL_WIDTH;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_PANEL_WIDTH;
    return n;
  } catch {
    return DEFAULT_PANEL_WIDTH;
  }
}

function writeStored(n: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // Private mode or quota exceeded — width still works in-session.
  }
}

function setCssVar(width: number): void {
  document.documentElement.style.setProperty(CSS_VAR, `${width}px`);
}

function readCssVar(): number | null {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(CSS_VAR);
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

// Module-load: seed the CSS variable synchronously before React mounts so
// the very first paint already has the persisted width — no flash from
// 640 to the saved value.
if (typeof window !== 'undefined') {
  setCssVar(clampWidth(readStored(), window.innerWidth));
}

export interface PanelWidthApi {
  width: number;
  setWidth: (n: number) => void;
  commit: (n: number) => void;
}

export function usePanelWidth(): PanelWidthApi {
  const [width, setWidthState] = useState<number>(() =>
    clampWidth(readStored(), window.innerWidth),
  );

  // Hot path during drag: write only to the CSS variable so React stays out
  // of the 60Hz pointermove loop. AgentPanel + main + divider all reflow via
  // the shared variable.
  const setWidth = useCallback((n: number) => {
    setCssVar(clampWidth(n, window.innerWidth));
  }, []);

  // Cold path on pointerup: persist and sync React state (drives ARIA).
  const commit = useCallback((n: number) => {
    const clamped = clampWidth(n, window.innerWidth);
    setCssVar(clamped);
    setWidthState(clamped);
    writeStored(clamped);
  }, []);

  // Re-clamp on viewport shrink. One-way: we don't grow the panel back when
  // the window re-enlarges, since the operator's intent was their last drag.
  useEffect(() => {
    function onResize() {
      const current = readCssVar();
      if (current == null) return;
      const clamped = clampWidth(current, window.innerWidth);
      if (clamped !== current) {
        setCssVar(clamped);
        setWidthState(clamped);
        writeStored(clamped);
      }
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { width, setWidth, commit };
}
