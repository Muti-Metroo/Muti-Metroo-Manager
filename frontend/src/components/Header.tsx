import { useCallback, useState } from 'react';
import type { TopologyAgentInfo } from '../api/types';
import { applyTheme, currentTheme, type Theme } from '../util/theme';

interface HeaderProps {
  agent: TopologyAgentInfo | null;
}

export default function Header({ agent }: HeaderProps) {
  // Seeded from the attribute the pre-paint script in index.html already
  // resolved, so the toggle can never disagree with what is on screen.
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggleTheme = useCallback(() => {
    setTheme(current => {
      const next: Theme = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return next;
    });
  }, []);

  return (
    <header className="border-hairline bg-base-100 flex-none border-b">
      <div className="flex items-center gap-3 px-4 py-2">
        <img src="/logo.png" alt="" aria-hidden="true" className="h-7 w-auto shrink-0" />
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="text-base-content text-base font-semibold tracking-tight">Muti Metroo</h1>
          <span className="text-muted hidden text-xs sm:inline">mesh operations</span>
        </div>

        <div className="ms-auto flex items-center gap-3">
          {agent && (
            <div className="hidden min-w-0 flex-col items-end leading-tight sm:flex">
              <span className="text-base-content truncate text-xs font-medium">
                {agent.display_name || agent.short_id}
              </span>
              <span className="text-muted font-mono text-[0.6875rem]">{agent.short_id}</span>
            </div>
          )}
          {!agent && <span className="text-muted text-xs">Connecting…</span>}
          <button
            type="button"
            className="btn btn-text btn-sm btn-square"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <span
              aria-hidden="true"
              className={`size-4 ${theme === 'dark' ? 'icon-[tabler--sun]' : 'icon-[tabler--moon]'}`}
            />
          </button>
        </div>
      </div>
    </header>
  );
}
