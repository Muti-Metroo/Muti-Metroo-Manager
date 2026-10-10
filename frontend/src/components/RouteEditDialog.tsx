import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useModalDismiss } from '../hooks/useModalDismiss';
import DialogHeader from './DialogHeader';

interface RouteEditDialogProps {
  target: string;
  initialComment?: string;
  initialSourceIp?: string;
  initialInterface?: string;
  sourceIpSuggestions?: string[];
  interfaceSuggestions?: string[];
  // Maps each known interface address back to its interface name, so we can
  // warn when the chosen source IP lives on a different NIC than the pinned
  // interface. IPs not present here are free-typed — no mismatch is asserted.
  ipToInterface?: Record<string, string>;
  loading?: boolean;
  onCancel: () => void;
  // Only fields that changed are passed back (undefined = unchanged).
  // Empty string is a legitimate value — it clears the field server-side.
  onSave: (changes: { comment?: string; sourceIp?: string; interface?: string }) => void;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function looksLikeIp(s: string): boolean {
  if (!s) return true;
  if (IPV4_RE.test(s)) {
    return s.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
  }
  return IPV6_RE.test(s) && s.includes(':');
}

// Text input with a filtered suggestion dropdown. Stays free-text editable —
// suggestions are hints, not a closed set (source IPs and interface names not
// enumerated by the agent remain typeable).
function Combobox({
  id,
  value,
  onChange,
  onSubmit,
  suggestions,
  disabled,
  invalid,
  placeholder,
  title,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  suggestions: string[];
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const deduped = useMemo(() => {
    const seen = new Set<string>();
    return suggestions.filter(s => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  }, [suggestions]);

  const filtered = useMemo(() => {
    const q = value.trim().toLowerCase();
    if (!q) return deduped;
    return deduped.filter(s => s.toLowerCase().includes(q));
  }, [deduped, value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <input
        id={id}
        type="text"
        className={`input input-sm w-full font-mono${invalid ? ' is-invalid' : ''}`}
        placeholder={placeholder}
        title={title}
        value={value}
        onChange={e => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={e => {
          // While the dropdown is open, Enter/Escape close only the dropdown and
          // must be fully swallowed: stopPropagation keeps them from reaching the
          // window-level handlers that submit or close the panel (e.g. AgentPanel's
          // Escape-to-close listener).
          if (e.key === 'Enter') {
            if (open) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else onSubmit();
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {open && deduped.length > 0 && (
        <div data-combobox-dropdown className="ui-popover inset-x-0 top-full mt-1 max-h-56">
          {filtered.length > 0 ? (
            filtered.map(s => (
              <div
                key={s}
                className="rounded-field hover:bg-base-200 cursor-pointer px-2 py-1 font-mono"
                onMouseDown={e => {
                  e.preventDefault();
                  onChange(s);
                  setOpen(false);
                }}
              >
                {s}
              </div>
            ))
          ) : (
            <div className="text-muted px-2 py-1 italic">No matches</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function RouteEditDialog({
  target,
  initialComment = '',
  initialSourceIp = '',
  initialInterface = '',
  sourceIpSuggestions = [],
  interfaceSuggestions = [],
  ipToInterface = {},
  loading = false,
  onCancel,
  onSave,
}: RouteEditDialogProps) {
  const [comment, setComment] = useState(initialComment);
  const [sourceIp, setSourceIp] = useState(initialSourceIp);
  const [iface, setIface] = useState(initialInterface);
  const fieldId = useId();
  useModalDismiss({ onClose: onCancel });

  const trimmedComment = comment.trim();
  const trimmedSourceIp = sourceIp.trim();
  const trimmedIface = iface.trim();
  const commentChanged = trimmedComment !== initialComment;
  const sourceIpChanged = trimmedSourceIp !== initialSourceIp;
  const ifaceChanged = trimmedIface !== initialInterface;
  const sourceIpValid = looksLikeIp(trimmedSourceIp);

  // The source IP's actual interface, when known. If it differs from the pinned
  // interface, the binding may not behave as expected — warn (advisory only).
  const sourceIpIface = ipToInterface[trimmedSourceIp];
  const ifaceMismatch = !!(
    trimmedSourceIp &&
    trimmedIface &&
    sourceIpIface &&
    sourceIpIface !== trimmedIface
  );

  const canSave = !loading && (commentChanged || sourceIpChanged || ifaceChanged);

  // Backdrop press: when a combobox dropdown is open, the first press closes only
  // the dropdown (the combobox's own outside-click listener fires on the same
  // mousedown) and keeps the modal up. mousedown — not click — so this gate is read
  // before that listener clears the dropdown from the DOM. A later press with no
  // dropdown open dismisses the modal. The dropdown is found by data attribute,
  // not class, so restyling the combobox cannot silently break this gate.
  const onOverlayMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || loading) return;
    if (e.currentTarget.querySelector('[data-combobox-dropdown]')) return;
    onCancel();
  };
  const submit = () => {
    if (!canSave) return;
    onSave({
      comment: commentChanged ? trimmedComment : undefined,
      sourceIp: sourceIpChanged ? trimmedSourceIp : undefined,
      interface: ifaceChanged ? trimmedIface : undefined,
    });
  };

  return (
    <div className="ui-overlay" onMouseDown={onOverlayMouseDown}>
      <div
        className="ui-dialog max-w-md"
        role="dialog"
        aria-modal="true"
        aria-label="Edit route"
        onClick={e => e.stopPropagation()}
      >
        <DialogHeader title="Edit route" onClose={onCancel} closeDisabled={loading} />
        <div className="ui-dialog-body space-y-3">
          <div className="font-mono break-all">{target}</div>

          <div className="space-y-1">
            <label className="block font-medium" htmlFor={`${fieldId}-comment`}>
              Comment
            </label>
            <input
              id={`${fieldId}-comment`}
              type="text"
              className="input input-sm w-full font-mono"
              placeholder="Comment (leave empty to clear)"
              value={comment}
              onChange={e => setComment(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              disabled={loading}
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <label className="block font-medium" htmlFor={`${fieldId}-srcip`}>
              Source IP{' '}
              <span className="text-muted font-normal">(optional, leave empty for default)</span>
            </label>
            <Combobox
              id={`${fieldId}-srcip`}
              value={sourceIp}
              onChange={setSourceIp}
              onSubmit={submit}
              suggestions={sourceIpSuggestions}
              disabled={loading}
              invalid={!!trimmedSourceIp && !sourceIpValid}
              placeholder="e.g. 192.168.1.42"
            />
            {trimmedSourceIp && !sourceIpValid && (
              <p className="text-error text-xs">
                Not a valid IPv4 or IPv6 literal, the agent will reject this on save.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="block font-medium" htmlFor={`${fieldId}-iface`}>
              Interface{' '}
              <span className="text-muted font-normal">(optional, egress NIC, e.g. eth0)</span>
            </label>
            <Combobox
              id={`${fieldId}-iface`}
              value={iface}
              onChange={setIface}
              onSubmit={submit}
              suggestions={interfaceSuggestions}
              disabled={loading}
              placeholder="e.g. eth0"
            />
            {ifaceMismatch && (
              <p className="text-warning text-xs">
                {trimmedSourceIp} is on {sourceIpIface}, not {trimmedIface}, an off-interface source
                only works if the agent runs as root on Linux (and the network supports it);
                otherwise the agent will reject this binding.
              </p>
            )}
          </div>
        </div>
        <div className="ui-dialog-footer">
          <button
            type="button"
            className="btn btn-sm btn-text"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!canSave}
            onClick={submit}
          >
            {loading ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
