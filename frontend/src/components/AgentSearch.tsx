import { useState, useMemo, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import type { TopologyAgentInfo, AgentMetadataMap } from '../api/types';

interface AgentSearchProps {
  agents: TopologyAgentInfo[];
  agentMeta: AgentMetadataMap;
  onSelect: (shortId: string) => void;
}

export interface AgentSearchHandle {
  focus: () => void;
}

// AgentSearch renders a header-level lookup. Fields searched, in ranked
// order: short/full ID, IP addresses, roles, display name, hostname,
// advertised exit/domain routes, port-forward keys, SOCKS5 address, and
// notes. Keyboard: arrow keys to navigate, Enter to open, Esc to clear.
// Imperative `focus()` is exposed so the global `/` hotkey in App can land
// focus here without prop-drilling the input ref.
interface Hit {
  agent: TopologyAgentInfo;
  score: number;
  // What matched (e.g. the IP, route, or note snippet) — surfaced in the
  // sub-line so the user understands *why* an agent appeared for a query
  // that didn't touch its name or hostname.
  matched?: string;
}

// Find the first entry in arr whose lowercased form passes test; return
// the original-cased value so we can display it verbatim in the result.
function firstHit(arr: string[] | undefined, test: (lower: string) => boolean): string | undefined {
  if (!arr) return undefined;
  for (const v of arr) if (test(v.toLowerCase())) return v;
  return undefined;
}

// Extract a windowed snippet around the first occurrence of q, trimming
// with ellipses if we're not at the ends. Keeps note previews short so
// long notes don't blow out the dropdown row.
function snippet(text: string, q: string, pad = 18): string {
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.length > 50 ? text.slice(0, 50) + '…' : text;
  const start = Math.max(0, idx - pad);
  const end = Math.min(text.length, idx + q.length + pad);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

const AgentSearch = forwardRef<AgentSearchHandle, AgentSearchProps>(function AgentSearch(
  { agents, agentMeta, onSelect },
  ref,
) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const expand = () => {
    setExpanded(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  useImperativeHandle(ref, () => ({ focus: expand }), []);

  const matches = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored: Hit[] = [];
    for (const a of agents) {
      const name = (a.display_name || '').toLowerCase();
      const host = (a.hostname || '').toLowerCase();
      const rawNote = agentMeta[a.id]?.note || '';
      const note = rawNote.toLowerCase();
      const short = a.short_id.toLowerCase();
      const full = a.id.toLowerCase();
      const socks = (a.socks5_addr || '').toLowerCase();

      // Tiered ranking: exact/identifier matches outrank substring matches,
      // and name/host outrank less-obvious fields (routes, forwards, notes).
      // Only the best-matching field is recorded in `matched` so the UI can
      // show the user which field hit.
      let score = -1;
      let matched: string | undefined;

      if (short.startsWith(q) || full.startsWith(q)) {
        score = 100;
      } else if ((matched = firstHit(a.ip_addresses, ip => ip === q))) {
        score = 90;
      } else if ((matched = firstHit(a.roles, r => r === q))) {
        score = 85;
      } else if (name.startsWith(q)) {
        score = 80;
      } else if ((matched = firstHit(a.ip_addresses, ip => ip.includes(q)))) {
        score = 75;
      } else if (host.startsWith(q)) {
        score = 70;
      } else if ((matched = firstHit(a.exit_routes, r => r.includes(q)))) {
        score = 65;
      } else if (name.includes(q)) {
        score = 60;
      } else if ((matched = firstHit(a.domain_routes, r => r.includes(q)))) {
        score = 58;
      } else if (
        (matched = firstHit(a.forward_listeners, k => k.includes(q))) ||
        (matched = firstHit(a.forward_endpoints, k => k.includes(q)))
      ) {
        score = 55;
      } else if (host.includes(q)) {
        score = 50;
      } else if (socks.includes(q)) {
        score = 45;
        matched = a.socks5_addr;
      } else if (note.includes(q)) {
        score = 20;
        matched = snippet(rawNote, q);
      }

      if (score >= 0) scored.push({ agent: a, score, matched });
    }
    scored.sort((x, y) => y.score - x.score);
    return scored.slice(0, 8);
  }, [agents, agentMeta, query]);

  // Keep the active index in range when the match list changes.
  useEffect(() => {
    if (activeIdx >= matches.length) setActiveIdx(0);
  }, [matches, activeIdx]);

  // Close (and collapse-if-empty) when clicking outside. Using pointerdown
  // so the click that actually triggers selection (onMouseDown inside the
  // menu) still runs before we close. We blur explicitly so the input's
  // onBlur path drives the collapse decision.
  useEffect(() => {
    if (!open && !expanded) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open, expanded]);

  const commit = (shortId: string) => {
    onSelect(shortId);
    setQuery('');
    setOpen(false);
    setExpanded(false);
    inputRef.current?.blur();
  };

  return (
    <div
      className={`relative flex items-center transition-[width] duration-200 ${
        expanded ? 'w-full' : 'w-8'
      }`}
      ref={containerRef}
    >
      <button
        type="button"
        className={`btn btn-sm btn-square btn-soft border-hairline bg-base-100 shrink-0 border shadow transition-opacity ${
          expanded ? 'pointer-events-none w-0 opacity-0' : 'opacity-100'
        }`}
        onClick={expand}
        aria-label="Search agents"
        title="Search agents ( / )"
        tabIndex={expanded ? -1 : 0}
      >
        <span className="icon-[tabler--search] size-4" aria-hidden="true" />
      </button>
      <input
        ref={inputRef}
        type="search"
        className={`input input-sm w-full min-w-0 transition-[width,opacity] duration-200 ${
          expanded ? 'opacity-100' : 'pointer-events-none w-0 border-transparent px-0 opacity-0'
        }`}
        placeholder="Search agents ( / )"
        value={query}
        onChange={e => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIdx(0);
        }}
        onFocus={() => {
          if (query) setOpen(true);
        }}
        onBlur={() => {
          if (!query) setExpanded(false);
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIdx(i => Math.min(i + 1, Math.max(0, matches.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx(i => Math.max(0, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const pick = matches[activeIdx];
            if (pick) commit(pick.agent.short_id);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            if (query) {
              setQuery('');
              setOpen(false);
            } else {
              inputRef.current?.blur();
            }
          }
        }}
        aria-label="Search agents"
        autoComplete="off"
        tabIndex={expanded ? 0 : -1}
      />
      {expanded && open && matches.length > 0 && (
        <ul className="ui-popover inset-x-0 top-full mt-1 max-h-80" role="listbox">
          {matches.map((h, i) => {
            const a = h.agent;
            const name = a.display_name || a.short_id;
            // If the match came from a non-obvious field (IP, route,
            // forward key, note), lead the sub-line with the matched
            // value so the user sees why this agent surfaced.
            const showMatched =
              h.matched && h.matched.toLowerCase() !== (a.hostname || '').toLowerCase();
            const subParts = showMatched
              ? [h.matched as string, a.short_id]
              : [a.hostname, a.short_id];
            const sub = subParts.filter(Boolean).join(' · ');
            return (
              <li
                key={a.short_id}
                role="option"
                aria-selected={i === activeIdx}
                className={`rounded-field flex cursor-pointer flex-col gap-0.5 px-2 py-1.5 ${
                  i === activeIdx ? 'bg-base-200' : ''
                }`}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={e => {
                  e.preventDefault();
                  commit(a.short_id);
                }}
              >
                <span className="font-medium">{name}</span>
                {sub && <span className="text-muted truncate font-mono text-xs">{sub}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {expanded && open && query && matches.length === 0 && (
        <div className="ui-popover text-muted inset-x-0 top-full mt-1 px-3 py-2">No matches</div>
      )}
    </div>
  );
});

export default AgentSearch;
