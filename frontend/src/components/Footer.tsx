import { useEffect, useState } from 'react';
import type { MeshHealth } from '../util/meshHealth';
import type { TickerEvent } from '../util/useTopologyDiff';

interface FooterProps {
  lastUpdate: Date | null;
  meshHealth: MeshHealth;
  meshTestAt: Date | null;
  polling: boolean;
  events: TickerEvent[];
  // Muti Metroo Manager binary version serving this UI; null until /healthz resolves.
  appVersion: string | null;
}

const FRESH_MS = 3000;

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

export default function Footer({
  lastUpdate,
  meshHealth,
  meshTestAt,
  polling,
  events,
  appVersion,
}: FooterProps) {
  const { total, reachable, unreachable } = meshHealth;
  const isDegraded = unreachable > 0;
  const latest = events[events.length - 1];

  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!latest) return;
    const elapsed = Date.now() - latest.ts;
    if (elapsed >= FRESH_MS) return;
    const t = setTimeout(() => forceTick(n => n + 1), FRESH_MS - elapsed);
    return () => clearTimeout(t);
  }, [latest]);

  const fresh = latest ? Date.now() - latest.ts < FRESH_MS : false;

  return (
    <footer className="border-hairline bg-base-100 text-muted flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-1.5 text-xs">
      <span className="flex items-center gap-3">
        <span>Last update: {lastUpdate ? lastUpdate.toLocaleTimeString() : 'Never'}</span>
        {total > 0 && (
          <span
            className={isDegraded ? 'text-warning font-medium' : undefined}
            title={
              isDegraded
                ? `${unreachable} agent${unreachable === 1 ? '' : 's'} unreachable`
                : 'All remote agents reachable'
            }
          >
            Mesh: {reachable}/{total} reachable
            {meshTestAt && ` · tested ${meshTestAt.toLocaleTimeString()}`}
          </span>
        )}
      </span>

      <span
        className={`min-w-0 flex-1 truncate transition-colors duration-500 ${
          fresh ? 'text-primary' : ''
        }`}
      >
        {latest && (
          <>
            <span className="font-mono opacity-70">[{formatTimestamp(latest.ts)}]</span>{' '}
            <span>{latest.text}</span>
          </>
        )}
      </span>

      <span className="ms-auto flex items-center gap-2">
        <span>
          {'©'} {new Date().getFullYear()} Team Muti Metroo
        </span>
        {appVersion && (
          <span
            className="font-mono opacity-80"
            title="Muti Metroo Manager version (server binary serving this UI)"
          >
            {appVersion}
          </span>
        )}
        <span
          aria-hidden="true"
          className={`status status-xs transition-opacity ${
            polling ? 'status-primary animate-pulse opacity-100' : 'opacity-40'
          }`}
        />
      </span>
    </footer>
  );
}
