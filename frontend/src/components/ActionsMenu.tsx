import { useState, useRef, useEffect } from 'react';
import type { SleepStatusResponse } from '../api/types';

interface ActionsMenuProps {
  sleepStatus: SleepStatusResponse | null;
  sleepLoading: boolean;
  testing: boolean;
  onSleep: () => void;
  onWake: () => void;
  onRunTest: () => void;
  onOpenAgentWizard: () => void;
  onOpenEntryWizard: () => void;
  onOpenSettings: () => void;
  // Sign out is only meaningful when a token is currently held — pass
  // null to hide the menu item (so a token-less deployment doesn't
  // expose an inert button).
  onSignOut?: (() => void) | null;
}

function getSleepMenuItem(
  status: SleepStatusResponse | null,
  loading: boolean,
): { label: string; icon: string; disabled: boolean; action: 'sleep' | 'wake' | null } | null {
  if (!status?.enabled) return null;

  if (loading) {
    const isSuspending = status.state === 'AWAKE';
    return {
      label: isSuspending ? 'Suspending...' : 'Resuming...',
      icon: 'icon-[tabler--loader-2]',
      disabled: true,
      action: null,
    };
  }

  switch (status.state) {
    case 'AWAKE':
      return {
        label: 'Suspend mesh',
        icon: 'icon-[tabler--zzz]',
        disabled: false,
        action: 'sleep',
      };
    case 'SLEEPING':
      return {
        label: 'Resume mesh',
        icon: 'icon-[tabler--player-play]',
        disabled: false,
        action: 'wake',
      };
    case 'POLLING':
      return {
        label: 'Transitioning...',
        icon: 'icon-[tabler--loader-2]',
        disabled: true,
        action: null,
      };
    default:
      return null;
  }
}

export default function ActionsMenu({
  sleepStatus,
  sleepLoading,
  testing,
  onSleep,
  onWake,
  onRunTest,
  onOpenAgentWizard,
  onOpenEntryWizard,
  onOpenSettings,
  onSignOut,
}: ActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmingSleep, setConfirmingSleep] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingSleep(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  function closeAndRun(action: () => void): void {
    setOpen(false);
    action();
  }

  function handleConfirmSleep(): void {
    setOpen(false);
    setConfirmingSleep(false);
    onSleep();
  }

  const sleepItem = getSleepMenuItem(sleepStatus, sleepLoading);

  function handleSleepItemClick(): void {
    if (!sleepItem || sleepItem.disabled) return;
    if (sleepItem.action === 'sleep') {
      setConfirmingSleep(true);
    } else if (sleepItem.action === 'wake') {
      closeAndRun(onWake);
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        className="btn btn-text btn-sm btn-square"
        onClick={() => {
          setOpen(v => !v);
          setConfirmingSleep(false);
        }}
        aria-label="Actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="icon-[tabler--dots-vertical] size-4" aria-hidden="true" />
      </button>

      {open && (
        <div role="menu" className="ui-popover end-0 top-full mt-1 min-w-72">
          {confirmingSleep ? (
            <div className="space-y-3 p-3">
              <p className="text-base-content/80">
                Put the mesh to sleep? All peer connections and tunnels will be suspended.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="btn btn-xs btn-text"
                  onClick={() => setConfirmingSleep(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-xs btn-warning"
                  onClick={handleConfirmSleep}
                >
                  Confirm
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuItem
                icon={testing ? 'icon-[tabler--loader-2]' : 'icon-[tabler--activity-heartbeat]'}
                spinning={testing}
                label={testing ? 'Testing...' : 'Mesh connectivity test'}
                disabled={testing}
                onClick={() => closeAndRun(onRunTest)}
              />
              <MenuItem
                icon="icon-[tabler--file-settings]"
                label="Generate Muti Metroo agent config..."
                onClick={() => closeAndRun(onOpenAgentWizard)}
              />
              <MenuItem
                icon="icon-[tabler--door-enter]"
                label="Generate Mutiauk config..."
                onClick={() => closeAndRun(onOpenEntryWizard)}
              />
              <MenuItem
                icon="icon-[tabler--settings]"
                label="Settings..."
                onClick={() => closeAndRun(onOpenSettings)}
              />
              {sleepItem && (
                <MenuItem
                  icon={sleepItem.icon}
                  spinning={sleepItem.disabled}
                  label={sleepItem.label}
                  disabled={sleepItem.disabled}
                  onClick={handleSleepItemClick}
                />
              )}
              {onSignOut && (
                <MenuItem
                  icon="icon-[tabler--logout]"
                  label="Sign out"
                  danger
                  onClick={() => closeAndRun(onSignOut)}
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface MenuItemProps {
  /** Tabler icon class, e.g. 'icon-[tabler--settings]'. */
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Spin the icon, the label already says the action is in flight. */
  spinning?: boolean;
  danger?: boolean;
}

function MenuItem({ icon, label, onClick, disabled, spinning, danger }: MenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`dropdown-item py-2 text-sm${danger ? ' text-error' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span
        className={`${icon} size-4 shrink-0${spinning ? ' animate-spin' : ''}`}
        aria-hidden="true"
      />
      {label}
    </button>
  );
}
