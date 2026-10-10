import { useCallback, useEffect, useRef } from 'react';
import { MIN_PANEL_WIDTH, maxPanelWidth } from '../util/usePanelWidth';

interface Props {
  width: number;
  onResize: (width: number) => void;
  onCommit: (width: number) => void;
}

function clamp(n: number, viewportWidth: number): number {
  const max = maxPanelWidth(viewportWidth);
  if (max < MIN_PANEL_WIDTH) return Math.max(0, Math.min(n, max));
  return Math.max(MIN_PANEL_WIDTH, Math.min(n, max));
}

export default function AgentPanelDivider({ width, onResize, onCommit }: Props) {
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const currentWidthRef = useRef(width);
  const draggingRef = useRef(false);

  useEffect(() => {
    currentWidthRef.current = width;
  }, [width]);

  // Window-level move/up handlers: keep the drag going when the pointer
  // leaves the 12px hit zone, and clean up classes even if this component
  // unmounts mid-drag (e.g. operator pressed Esc to close the panel).
  // Without that fallback, body.panel-dragging would stay set and lock the
  // entire UI under cursor:col-resize + user-select:none.
  useEffect(() => {
    function endDrag() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.classList.remove('panel-dragging');
      document.querySelector('main')?.classList.remove('panel-resizing');
      onCommit(currentWidthRef.current);
    }
    function onMove(e: PointerEvent) {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      const next = clamp(startWidthRef.current - delta, window.innerWidth);
      currentWidthRef.current = next;
      onResize(next);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    return () => {
      // If unmounting mid-drag (e.g. operator pressed Esc to close the panel
      // before pointerup), end the drag here so we (a) persist the in-flight
      // width and (b) clear the global dragging classes — otherwise the UI
      // is stuck under cursor:col-resize !important + user-select:none.
      endDrag();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', endDrag);
      window.removeEventListener('pointercancel', endDrag);
    };
  }, [onResize, onCommit]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    draggingRef.current = true;
    startXRef.current = e.clientX;
    startWidthRef.current = currentWidthRef.current;
    document.body.classList.add('panel-dragging');
    document.querySelector('main')?.classList.add('panel-resizing');
  }, []);

  return (
    <div
      className="agent-panel-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize agent panel"
      aria-valuenow={width}
      aria-valuemin={Math.min(MIN_PANEL_WIDTH, maxPanelWidth(window.innerWidth))}
      aria-valuemax={maxPanelWidth(window.innerWidth)}
      tabIndex={-1}
      onPointerDown={onPointerDown}
    >
      <div className="agent-panel-divider-line" />
    </div>
  );
}
