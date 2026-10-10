import type { AgentMetadataMap, NetworkNameMap } from '../api/types';

// Network membership is stored per agent as a comma-separated list of
// identifiers (see AgentMeta.networks). Identifiers are [a-zA-Z0-9_-]{1,64}
// — no spaces or commas — so the list is unambiguous. These helpers are the
// single source of truth for splitting and normalizing that string, shared
// by the InfoTab editor and the topology map.

const MAX_ID_LEN = 64;

// normalizeNetworks turns free-form editor input into the canonical stored
// form: strips characters that can't appear in an identifier, drops empty
// tokens, de-duplicates, and re-joins with commas. "prod, edge 1,,prod"
// becomes "prod,edge1".
export function normalizeNetworks(raw: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tok = part.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, MAX_ID_LEN);
    if (tok && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out.join(',');
}

// parseNetworks splits a stored (already-normalized) membership string into
// its identifiers. Tolerant of stray empty tokens just in case.
export function parseNetworks(v: string): string[] {
  if (!v) return [];
  return v.split(',').filter(t => t.length > 0);
}

// --- Typeahead support -----------------------------------------------------

/** A network the operator has already used somewhere in the mesh. */
export interface KnownNetwork {
  /** The stored identifier, e.g. "pubnet". */
  id: string;
  /** Operator-set display title, or '' when the id is shown as-is. */
  title: string;
}

// knownNetworks lists every network the mesh knows about: those an agent is a
// member of, plus any that only exist because they were given a title. Sorted
// by id so the suggestion order is stable between renders.
export function knownNetworks(meta: AgentMetadataMap, names: NetworkNameMap): KnownNetwork[] {
  const ids = new Set<string>();
  for (const m of Object.values(meta)) {
    for (const id of parseNetworks(m.networks)) ids.add(id);
  }
  for (const id of Object.keys(names)) ids.add(id);
  return [...ids].sort((a, b) => a.localeCompare(b)).map(id => ({ id, title: titleOf(names, id) }));
}

// Own properties only: a network literally named "constructor" would otherwise
// read a function off the prototype chain and blow up every caller that treats
// a title as a string.
function titleOf(names: NetworkNameMap, id: string): string {
  // hasOwnProperty via call, not Object.hasOwn: the project targets ES2020.
  const title = Object.prototype.hasOwnProperty.call(names, id) ? names[id] : undefined;
  return typeof title === 'string' ? title : '';
}

/** The comma-separated token the caret sits in, and its bounds in `value`. */
interface CaretToken {
  text: string;
  start: number;
  end: number;
}

// tokenAtCaret finds the comma-delimited token the caret is inside. Editing
// "prod,edge" with the caret after "ed" yields that token, so the typeahead
// completes the identifier being typed rather than the whole field.
export function tokenAtCaret(value: string, caret: number): CaretToken {
  const pos = Math.max(0, Math.min(caret, value.length));
  const start = value.lastIndexOf(',', pos - 1) + 1;
  const commaAfter = value.indexOf(',', pos);
  const end = commaAfter === -1 ? value.length : commaAfter;
  return { text: value.slice(start, end).trim(), start, end };
}

// replaceTokenAtCaret swaps the token under the caret for `id`, returning the
// new field value and where the caret should land (just after the insertion).
export function replaceTokenAtCaret(
  value: string,
  caret: number,
  id: string,
): { value: string; caret: number } {
  const { start, end } = tokenAtCaret(value, caret);
  const next = value.slice(0, start) + id + value.slice(end);
  return { value: next, caret: start + id.length };
}
