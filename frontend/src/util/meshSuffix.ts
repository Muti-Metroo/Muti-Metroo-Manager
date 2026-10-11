// RFC 1035 label after lowercasing: letters, digits, hyphens; must
// start and end with alnum; up to 63 chars. Mirrors the regex used by
// Muti Metroo's hosts package (internal/hosts/store.go).
const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// Returns the matching suffix (e.g. "mesh" or "muti-metroo.alt") if name
// ends with `.<suffix>` (e.g. `host.mesh` under suffix `mesh`) or
// equals a multi-level suffix exactly (e.g. `muti-metroo.alt` under suffix
// `muti-metroo.alt` — still has two labels). Single-label names are
// rejected outright: the agent's hosts store enforces the same rule,
// so registering `mesh` itself against the `mesh` suffix is invalid.
// The longest matching suffix wins so hostnames under `muti-metroo.alt`
// don't accidentally match a shorter `alt` suffix.
export function matchSuffix(name: string, suffixes: readonly string[]): string | null {
  if (!name.includes('.')) return null;
  let best: string | null = null;
  for (const s of suffixes) {
    const tail = `.${s}`;
    const isBare = name === s;
    const isPrefixed = name.endsWith(tail) && name.length > tail.length;
    if (isBare || isPrefixed) {
      if (!best || s.length > best.length) best = s;
    }
  }
  return best;
}

// Validates a TLD suffix client-side using the same rules Muti Metroo applies
// server-side (internal/hosts/store.go normalizeSuffix): lowercase, no
// leading/trailing dot, every dot-separated piece is a valid RFC 1035
// label. Returns the canonical (trimmed, lowercased) form on success or
// a human-readable error string. Multi-level suffixes ("muti-metroo.alt") are
// accepted.
export function normalizeSuffix(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const v = raw.trim().toLowerCase();
  if (v === '') return { ok: false, error: 'Suffix is required.' };
  if (v.startsWith('.')) return { ok: false, error: 'Suffix must not start with a dot.' };
  if (v.endsWith('.')) return { ok: false, error: 'Suffix must not end with a dot.' };
  for (const label of v.split('.')) {
    if (!LABEL_RE.test(label)) {
      return { ok: false, error: `"${label}" is not a valid DNS label.` };
    }
  }
  return { ok: true, value: v };
}
