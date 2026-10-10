import { useEffect } from 'react';

// Module-scoped count of open modals, read live inside event handlers — no
// React state, so registering a modal causes no re-render. The app's global
// Escape closers (App.tsx, AgentPanel) consult isModalOpen() so a modal's
// Escape dismisses only the modal, leaving the agent panel open.
let openCount = 0;

export function isModalOpen(): boolean {
  return openCount > 0;
}

// Register a modal while `open` (default true, for modals that only mount when
// open). When `onClose` is given, also installs an Escape→onClose listener so
// the modal self-dismisses; modals that already have their own Escape listener
// pass no onClose and just register.
export function useModalDismiss(opts: { open?: boolean; onClose?: () => void } = {}) {
  const { open = true, onClose } = opts;
  useEffect(() => {
    if (!open) return;
    openCount++;
    const onKey = onClose
      ? (e: KeyboardEvent) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }
      : null;
    if (onKey) window.addEventListener('keydown', onKey);
    return () => {
      openCount--;
      if (onKey) window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
}
