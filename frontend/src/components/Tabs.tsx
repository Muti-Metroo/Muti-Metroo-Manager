import type { ReactNode } from 'react';

export interface TabDef<T extends string = string> {
  id: T;
  label: string;
  // A capability the agent does not offer (no shell, no file transfer).
  // The button stays visible so the operator can see the tab exists.
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  tabs: TabDef<T>[];
  activeId: T;
  onChange: (id: T) => void;
  // 'sm' is the second-level strip used inside a major tab or an agent-panel
  // tab, visually lighter so the hierarchy stays readable with both on screen.
  size?: 'md' | 'sm';
  // Trailing content pinned to the right of the strip (the actions menu).
  rightSlot?: ReactNode;
  className?: string;
}

/**
 * The app's only tab strip. Every level goes through it: the major tabs, the
 * agent panel, and the sub-tabs inside routes, DNS, connectivity and
 * forwards. That keeps the roles, the active-class convention and the
 * disabled handling in one place.
 */
export default function Tabs<T extends string>({
  tabs,
  activeId,
  onChange,
  size = 'md',
  rightSlot,
  className = '',
}: TabsProps<T>) {
  const strip = (
    <div
      className={`tabs tabs-bordered min-w-0 flex-1 overflow-x-auto${size === 'sm' ? ' tabs-sm' : ''}`}
      role="tablist"
    >
      {tabs.map(t => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={activeId === t.id}
          className={`tab whitespace-nowrap${activeId === t.id ? ' tab-active' : ''}`}
          onClick={() => !t.disabled && onChange(t.id)}
          disabled={t.disabled}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {strip}
      {rightSlot && <div className="flex shrink-0 items-center gap-1 pe-1">{rightSlot}</div>}
    </div>
  );
}
