import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  parseNetworks,
  replaceTokenAtCaret,
  tokenAtCaret,
  type KnownNetwork,
} from '../../util/networks';

interface NetworksFieldProps {
  /** Raw editor text: a comma-separated membership list. */
  value: string;
  onChange: (value: string) => void;
  /** Normalise and persist. Called on blur and on Enter. */
  onCommit: () => void;
  /** Every network already used anywhere in the mesh. */
  known: KnownNetwork[];
}

/**
 * The agent's network membership, with a typeahead over the networks that
 * already exist in the mesh.
 *
 * The field stays free text so an operator can always name a brand-new
 * network by typing it, but suggestions turn the common case (put this agent in the
 * network I already made) into one keystroke, and remove the chance of a typo
 * silently creating a second, near-identical network.
 *
 * The list is comma-separated, so the typeahead works on the token under the
 * caret rather than the whole field.
 */
export default function NetworksField({ value, onChange, onCommit, known }: NetworksFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // The agent panel keeps every opened agent mounted, so several of these can
  // be in the document at once; a fixed id would collide.
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [caret, setCaret] = useState(0);
  // -1 = nothing highlighted. Enter is overloaded here (commit the field, or
  // take a suggestion), so nothing may be pre-selected: typing a brand-new
  // name that happens to prefix an existing one and pressing Enter must keep
  // what was typed, not silently swap in the existing network.
  const [activeIdx, setActiveIdx] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const token = tokenAtCaret(value, caret).text.toLowerCase();
    // Networks already in the list are not offered again, picking one would
    // be a no-op that normalizeNetworks collapses anyway. The token being
    // edited is exempt, or it would vanish from its own suggestions.
    const claimed = new Set(parseNetworks(value.toLowerCase().replace(/\s+/g, '')));
    return known
      .filter(n => {
        const id = n.id.toLowerCase();
        if (id !== token && claimed.has(id)) return false;
        return !token || id.includes(token) || n.title.toLowerCase().includes(token);
      })
      .slice(0, 8);
  }, [known, value, caret]);

  const syncCaret = useCallback(() => {
    setCaret(inputRef.current?.selectionStart ?? value.length);
  }, [value.length]);

  const pick = useCallback(
    (id: string) => {
      const next = replaceTokenAtCaret(value, caret, id);
      onChange(next.value);
      setOpen(false);
      // Restore focus and drop the caret after the inserted id, so typing a
      // comma continues the list where the operator left off.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [value, caret, onChange],
  );

  const showList = open && matches.length > 0;
  const activeId = showList && activeIdx >= 0 ? `${listId}-${activeIdx}` : undefined;

  // Keep the highlighted option in view: the list scrolls once there are more
  // suggestions than fit, and arrowing to one below the fold would otherwise
  // move a highlight nobody can see.
  useEffect(() => {
    if (!activeId) return;
    listRef.current
      ?.querySelector(`#${CSS.escape(activeId)}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={showList}
        // Only while the list exists: aria-controls pointing at an absent id
        // is an invalid reference.
        aria-controls={showList ? listId : undefined}
        aria-activedescendant={activeId}
        aria-autocomplete="list"
        className="input input-sm w-full font-mono"
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
          setOpen(true);
          setActiveIdx(-1);
        }}
        onFocus={() => {
          syncCaret();
          setOpen(true);
        }}
        onClick={syncCaret}
        onKeyUp={syncCaret}
        onBlur={() => {
          setOpen(false);
          onCommit();
        }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIdx(i => Math.min(i + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            // Back past the first option returns to "nothing highlighted",
            // so Enter commits what was typed again.
            setActiveIdx(i => Math.max(-1, i - 1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (showList && activeIdx >= 0 && matches[activeIdx]) pick(matches[activeIdx].id);
            else onCommit();
          } else if (e.key === 'Escape' && showList) {
            // Swallowed: the agent panel closes on Escape, and the first press
            // should only dismiss the suggestions.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            onCommit();
          }
        }}
        placeholder="Comma-separated, e.g. prod,edge-1"
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        aria-label="Networks"
      />

      {showList && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Existing networks"
          className="ui-popover inset-x-0 top-full mt-1 max-h-64"
        >
          {matches.map((n, i) => (
            <li
              key={n.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              className={`rounded-field flex cursor-pointer items-baseline gap-2 px-2 py-1.5 ${
                i === activeIdx ? 'bg-base-200' : ''
              }`}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => {
                // Select before the input's blur can commit and close the list.
                e.preventDefault();
                pick(n.id);
              }}
            >
              <span className="font-mono font-medium">{n.id}</span>
              {n.title && <span className="text-muted min-w-0 truncate text-xs">{n.title}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
