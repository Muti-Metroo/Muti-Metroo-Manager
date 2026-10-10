// Copies text to the system clipboard. Prefers the async Clipboard API and
// falls back to a hidden textarea + document.execCommand('copy'), which still
// works in contexts where the async API is unavailable or silently rejects
// (e.g. cross-origin iframes, policies that disallow clipboard-write, or
// browsers that gate the async API behind a permission prompt the page
// never surfaces). Resolves to true on success, false otherwise.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy path.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  const prevSelection = document.getSelection()?.rangeCount
    ? document.getSelection()!.getRangeAt(0)
    : null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (prevSelection) {
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(prevSelection);
  }
  return ok;
}
