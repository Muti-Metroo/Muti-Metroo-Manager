import { useEffect, useRef } from 'react';
import { AGENT_ICONS, ICON_GROUPS, AgentIcon, type IconGroup } from '../MetroMap/agentIcons';
import { useModalDismiss } from '../../hooks/useModalDismiss';
import DialogHeader from '../DialogHeader';

interface IconPickerProps {
  current: string;
  onPick: (iconKey: string) => void;
  onClose: () => void;
}

// Modal popover anchored to the agent panel. Lists every catalog entry
// grouped by IconDef.group so an operator can see all options at once.
// Picking an icon closes the modal; "Clear" clears the current icon.
export default function IconPicker({ current, onPick, onClose }: IconPickerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc dismiss (shared hook also flags a modal as open so the agent panel's
  // own Escape handler stays put). Outside-click dismiss uses mousedown so a
  // click on a grid button still fires before the close runs.
  useModalDismiss({ onClose });
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (!dialogRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener('mousedown', onMouse);
    return () => window.removeEventListener('mousedown', onMouse);
  }, [onClose]);

  return (
    <div className="ui-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="ui-dialog max-w-lg"
        role="dialog"
        aria-modal="true"
        aria-label="Choose station icon"
      >
        <DialogHeader title="Choose icon" onClose={onClose} />

        <div className="ui-dialog-body space-y-4">
          {ICON_GROUPS.map((group: IconGroup) => {
            const items = AGENT_ICONS.filter(i => i.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <div className="text-muted mb-1.5 text-xs font-semibold tracking-wide uppercase">
                  {group}
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1.5">
                  {items.map(def => (
                    <button
                      type="button"
                      key={def.key}
                      className={`rounded-field flex flex-col items-center gap-1 border p-2 transition-colors ${
                        def.key === current
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-hairline hover:bg-base-200'
                      }`}
                      onClick={() => {
                        onPick(def.key);
                        onClose();
                      }}
                      title={def.label}
                      aria-label={def.label}
                      aria-pressed={def.key === current}
                    >
                      <AgentIcon kind={def.key} size={28} />
                      <span className="w-full truncate text-center text-[0.6875rem]">
                        {def.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <div className="ui-dialog-footer">
          <button
            type="button"
            className="btn btn-sm btn-text"
            onClick={() => {
              onPick('');
              onClose();
            }}
            disabled={!current}
          >
            Clear icon (use default circle)
          </button>
        </div>
      </div>
    </div>
  );
}
