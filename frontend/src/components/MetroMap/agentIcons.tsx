import type { ReactNode } from 'react';

export type IconKey =
  | 'windows'
  | 'macos'
  | 'linux'
  | 'server'
  | 'router'
  | 'switch'
  | 'firewall'
  | 'modem'
  | 'gateway'
  | 'database'
  | 'disk'
  | 'cloud'
  | 'container'
  | 'plc'
  | 'valve'
  | 'pump'
  | 'sensor'
  | 'motor'
  | 'hmi'
  | 'camera'
  | 'terminal'
  | 'mobile'
  | 'raspberry-pi'
  | 'iot';

export type IconGroup = 'OS' | 'Network' | 'Compute' | 'Storage' | 'Industrial' | 'Other';

export interface IconDef {
  key: IconKey;
  label: string;
  group: IconGroup;
  // Inline paths drawn into a 24x24 viewBox. Use currentColor so the
  // station's CSS state class (local/connected/remote) can tint the icon.
  paths: ReactNode;
}

// Order within a group is the display order in the picker.
export const AGENT_ICONS: IconDef[] = [
  // ----- OS -----
  {
    key: 'windows',
    label: 'Windows',
    group: 'OS',
    paths: (
      <>
        <path d="M3 5.4 11 4.2v7.3H3z" />
        <path d="M12 4.05 21 2.7v8.8H12z" />
        <path d="M3 12.5h8V20l-8-1.2z" />
        <path d="M12 12.5h9v9l-9-1.35z" />
      </>
    ),
  },
  {
    key: 'macos',
    label: 'macOS',
    group: 'OS',
    paths: (
      <>
        <path d="M17.05 20.28c-.98.95-2.05.94-3.08.43-1.09-.5-2.07-.55-3.18 0-1.39.6-2.13.43-3-.05C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.19 2.31-.89 3.51-.84 1.54.07 2.68.65 3.4 1.78-3.13 1.81-2.28 5.94.85 7.06-.71 1.93-1.62 3.84-2.84 4.17z" />
        <path d="M12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
      </>
    ),
  },
  {
    key: 'linux',
    label: 'Linux',
    group: 'OS',
    paths: (
      <>
        {/* Tux body — currentColor silhouette */}
        <path d="M12 2.2c-1.7 0-3 1.3-3 3v3.3c0 .6-.3 1.1-.9 1.7-1.2 1.2-2.1 2.6-2.1 4.6 0 1.4.5 2.6 1 3.4l-1 2 2-.4 1 1.4h6l1-1.4 2 .4-1-2c.5-.8 1-2 1-3.4 0-2-.9-3.4-2.1-4.6-.6-.6-.9-1.1-.9-1.7V5.2c0-1.7-1.3-3-3-3z" />
        {/* Belly in the surface colour so the penguin reads as a penguin against
            the silhouette, in either theme */}
        <ellipse cx="12" cy="14.5" rx="3" ry="4" fill="var(--color-base-100)" opacity=".75" />
        {/* Eyes */}
        <ellipse cx="10.5" cy="6.7" rx="1" ry="1.4" fill="var(--color-base-100)" />
        <ellipse cx="13.5" cy="6.7" rx="1" ry="1.4" fill="var(--color-base-100)" />
        <circle cx="10.7" cy="7" r=".55" fill="var(--color-base-content)" />
        <circle cx="13.3" cy="7" r=".55" fill="var(--color-base-content)" />
        {/* Beak */}
        <path d="M12 8.6l-1.5 1.6h3z" fill="var(--color-warning)" />
        {/* Feet */}
        <ellipse cx="10" cy="20" rx="1.4" ry=".7" fill="var(--color-warning)" />
        <ellipse cx="14" cy="20" rx="1.4" ry=".7" fill="var(--color-warning)" />
      </>
    ),
  },
  {
    key: 'server',
    label: 'Server',
    group: 'OS',
    paths: (
      <>
        <path d="M3 4h18v5H3zm0 6h18v5H3zm0 6h18v5H3z" fillRule="evenodd" />
        <circle cx="6" cy="6.5" r=".9" fill="var(--color-base-100)" />
        <circle cx="6" cy="12.5" r=".9" fill="var(--color-base-100)" />
        <circle cx="6" cy="18.5" r=".9" fill="var(--color-base-100)" />
        <rect x="15" y="6" width="5" height="1.2" fill="var(--color-base-100)" />
        <rect x="15" y="12" width="5" height="1.2" fill="var(--color-base-100)" />
        <rect x="15" y="18" width="5" height="1.2" fill="var(--color-base-100)" />
      </>
    ),
  },

  // ----- Network -----
  {
    key: 'router',
    label: 'Router',
    group: 'Network',
    paths: (
      <>
        <path d="M5 5l1 5h-1zM10 5h1l-1 5h-1zM18 5h1l-1 5h-1z" />
        <path d="M5.5 5h1l1 5h-1zM10.5 5h1l1 5h-1zM18.5 5h1l1 5h-1z" />
        <rect x="2" y="13" width="20" height="7" rx="1.5" />
        <circle cx="6" cy="16.5" r=".9" fill="var(--color-success)" />
        <circle cx="9" cy="16.5" r=".9" fill="var(--color-success)" />
        <circle cx="12" cy="16.5" r=".9" fill="var(--color-warning)" />
        <circle cx="18" cy="16.5" r=".9" fill="var(--color-base-100)" />
      </>
    ),
  },
  {
    key: 'switch',
    label: 'Switch',
    group: 'Network',
    paths: (
      <>
        <rect x="2" y="7" width="20" height="10" rx="1.5" />
        <rect x="4" y="9.5" width="2" height="2" fill="var(--color-base-100)" />
        <rect x="7" y="9.5" width="2" height="2" fill="var(--color-base-100)" />
        <rect x="10" y="9.5" width="2" height="2" fill="var(--color-base-100)" />
        <rect x="13" y="9.5" width="2" height="2" fill="var(--color-base-100)" />
        <rect x="16" y="9.5" width="2" height="2" fill="var(--color-base-100)" />
        <rect x="19" y="9.5" width="1" height="2" fill="var(--color-base-100)" />
        <circle cx="5" cy="14.5" r=".7" fill="var(--color-success)" />
        <circle cx="8" cy="14.5" r=".7" fill="var(--color-success)" />
        <circle cx="11" cy="14.5" r=".7" fill="var(--color-success)" />
        <circle cx="14" cy="14.5" r=".7" fill="var(--color-warning)" />
        <circle cx="17" cy="14.5" r=".7" fill="var(--color-success)" />
      </>
    ),
  },
  {
    key: 'firewall',
    label: 'Firewall',
    group: 'Network',
    paths: (
      <>
        <path d="M12 2 4 5v6c0 5 3.4 9.5 8 11 4.6-1.5 8-6 8-11V5z" />
        <path
          d="M5.5 7.5h13M5.5 11h13M5.5 14.5h13"
          stroke="var(--color-base-100)"
          strokeWidth="1"
          fill="none"
        />
        <path
          d="M9 6v3M14 6v3M11 9.5v3M16 9.5v3M9 13v3M14 13v3"
          stroke="var(--color-base-100)"
          strokeWidth="1"
          fill="none"
        />
      </>
    ),
  },
  {
    key: 'modem',
    label: 'Modem',
    group: 'Network',
    paths: (
      <>
        <path d="M5 7c2-2 5-3 7-3s5 1 7 3l-1 1c-2-1.5-4-2.5-6-2.5s-4 1-6 2.5z" />
        <path d="M7 9.5c1-1 3-2 5-2s4 1 5 2l-1 1c-1-.7-2.5-1.5-4-1.5s-3 .8-4 1.5z" />
        <rect x="3" y="13" width="18" height="7" rx="1.5" />
        <circle cx="7" cy="16.5" r=".9" fill="var(--color-success)" />
        <circle cx="10" cy="16.5" r=".9" fill="var(--color-success)" />
        <circle cx="13" cy="16.5" r=".9" fill="var(--color-warning)" />
        <rect x="16" y="15.5" width="4" height="2" fill="var(--color-base-100)" />
      </>
    ),
  },
  {
    key: 'gateway',
    label: 'Gateway',
    group: 'Network',
    paths: (
      <>
        <rect x="2" y="6" width="20" height="12" rx="1.5" />
        <path
          d="M6 12h6m0 0-2-2m2 2-2 2"
          stroke="var(--color-base-100)"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M18 12h-6m6 0-2-2m2 2-2 2"
          stroke="var(--color-base-100)"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ),
  },

  // ----- Compute -----
  {
    key: 'cloud',
    label: 'Cloud',
    group: 'Compute',
    paths: (
      <path d="M7 19c-2.7 0-5-2.2-5-5 0-2.5 2-4.7 4.5-5 .8-2.3 3-4 5.5-4 3.2 0 5.8 2.5 5.9 5.6h.1c2.2 0 4 1.8 4 4 0 2.4-2 4.4-4.5 4.4z" />
    ),
  },
  {
    key: 'container',
    label: 'Container',
    group: 'Compute',
    paths: (
      <>
        <rect x="2.5" y="6" width="19" height="12" rx="1" />
        <path
          d="M5.5 7.5v9M8.5 7.5v9M11.5 7.5v9M14.5 7.5v9M17.5 7.5v9"
          stroke="var(--color-base-100)"
          strokeWidth="0.9"
          fill="none"
        />
        <rect x="2.5" y="6" width="19" height="2" fill="var(--color-base-100)" opacity=".15" />
        <rect x="2.5" y="16" width="19" height="2" fill="var(--color-base-100)" opacity=".15" />
      </>
    ),
  },
  {
    key: 'raspberry-pi',
    label: 'Raspberry Pi',
    group: 'Compute',
    paths: (
      <>
        <rect x="2" y="6" width="20" height="12" rx="1" />
        <rect x="9" y="9" width="6" height="6" />
        <path
          d="M5 7v2M5 10v2M5 13v2M5 16v1M7 7v2M7 10v2M7 13v2M7 16v1M17 7v2M17 10v2M17 13v2M17 16v1M19 7v2M19 10v2M19 13v2M19 16v1"
          stroke="var(--color-base-100)"
          strokeWidth="0.9"
        />
      </>
    ),
  },
  {
    key: 'mobile',
    label: 'Mobile / IoT',
    group: 'Compute',
    paths: (
      <>
        <rect x="6" y="2" width="12" height="20" rx="2" />
        <rect x="7.5" y="4" width="9" height="14" fill="var(--color-base-100)" opacity=".25" />
        <circle cx="12" cy="20" r=".9" fill="var(--color-base-100)" />
      </>
    ),
  },

  // ----- Storage -----
  {
    key: 'database',
    label: 'Database',
    group: 'Storage',
    paths: (
      <>
        <ellipse cx="12" cy="5" rx="8" ry="2.5" />
        <path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" />
        <path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
        <ellipse cx="12" cy="11" rx="8" ry="2.5" fill="var(--color-base-100)" opacity=".15" />
        <ellipse cx="12" cy="17" rx="8" ry="2.5" fill="var(--color-base-100)" opacity=".15" />
      </>
    ),
  },
  {
    key: 'disk',
    label: 'Disk',
    group: 'Storage',
    paths: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="1.5" />
        <circle cx="12" cy="12" r="4" fill="var(--color-base-100)" opacity=".18" />
        <circle cx="12" cy="12" r="1.2" fill="var(--color-base-100)" />
        <circle cx="18.5" cy="9" r=".7" fill="var(--color-success)" />
      </>
    ),
  },

  // ----- Industrial -----
  {
    key: 'plc',
    label: 'PLC',
    group: 'Industrial',
    paths: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="1" />
        <rect x="5" y="6" width="3" height="3" fill="var(--color-base-100)" opacity=".3" />
        <circle cx="11" cy="7.5" r=".7" fill="var(--color-success)" />
        <circle cx="13" cy="7.5" r=".7" fill="var(--color-warning)" />
        <circle cx="15" cy="7.5" r=".7" fill="var(--color-base-100)" />
        <circle cx="17" cy="7.5" r=".7" fill="var(--color-base-100)" />
        <rect x="5" y="11" width="14" height="4" fill="var(--color-base-100)" opacity=".15" />
        <path
          d="M5 18v2M8 18v2M11 18v2M14 18v2M17 18v2M19 18v2"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </>
    ),
  },
  {
    key: 'valve',
    label: 'Valve',
    group: 'Industrial',
    paths: (
      <>
        <path d="M2 12h6m8 0h6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M8 8 L16 16 M16 8 L8 16" stroke="currentColor" strokeWidth="2" />
        <path d="M8 8h8v8H8z" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="3" width="2" height="4" />
        <rect x="9" y="2.5" width="6" height="1.5" />
      </>
    ),
  },
  {
    key: 'pump',
    label: 'Pump',
    group: 'Industrial',
    paths: (
      <>
        <circle cx="12" cy="12" r="7" />
        <path d="M12 6 L17 12 L12 18 L7 12 Z" fill="var(--color-base-100)" opacity=".25" />
        <path d="M12 8.5 L14.5 12 L12 15.5 L9.5 12 Z" fill="var(--color-base-100)" />
        <path d="M2 12h3M19 12h3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </>
    ),
  },
  {
    key: 'sensor',
    label: 'Sensor',
    group: 'Industrial',
    paths: (
      <>
        <path d="M4 16a8 8 0 0 1 16 0" />
        <path d="M5.5 16a6.5 6.5 0 0 1 13 0" fill="var(--color-base-100)" opacity=".2" />
        <path
          d="M12 16 L17 9"
          stroke="var(--color-base-100)"
          strokeWidth="1.6"
          strokeLinecap="round"
        />
        <circle cx="12" cy="16" r="1.2" fill="var(--color-base-100)" />
        <rect x="3" y="16" width="18" height="2" />
      </>
    ),
  },
  {
    key: 'motor',
    label: 'Motor',
    group: 'Industrial',
    paths: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path
          d="M7 16V8h1.5l1.7 5.2L12 8h1.5v8H12V10l-1.7 5.2H10L8.3 10v6z"
          fill="var(--color-base-100)"
        />
      </>
    ),
  },
  {
    key: 'hmi',
    label: 'HMI Panel',
    group: 'Industrial',
    paths: (
      <>
        <rect x="2" y="3" width="20" height="14" rx="1.5" />
        <rect x="3.5" y="4.5" width="17" height="11" fill="var(--color-base-100)" opacity=".2" />
        <circle cx="6" cy="7" r=".8" fill="var(--color-success)" />
        <rect x="8.5" y="6.2" width="9" height="1.5" fill="var(--color-base-100)" />
        <rect x="8.5" y="9.5" width="11" height="4" fill="var(--color-base-100)" opacity=".4" />
        <rect x="9" y="19" width="6" height="2" fill="currentColor" />
        <rect x="6" y="20.5" width="12" height="1.5" />
      </>
    ),
  },

  // ----- Other -----
  {
    key: 'camera',
    label: 'Camera',
    group: 'Other',
    paths: (
      <>
        <rect x="2" y="7" width="14" height="10" rx="1.5" />
        <path d="M16 10.5l5-2.5v8l-5-2.5z" />
        <circle cx="6" cy="12" r=".8" fill="var(--color-error)" />
      </>
    ),
  },
  {
    key: 'terminal',
    label: 'Terminal',
    group: 'Other',
    paths: (
      <>
        <rect x="2" y="4" width="20" height="14" rx="1.5" />
        <rect
          x="3.5"
          y="5.5"
          width="17"
          height="11"
          fill="var(--color-base-content)"
          opacity=".55"
        />
        <path
          d="M6 9l3 2.5L6 14"
          stroke="var(--color-success)"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <rect x="10.5" y="13" width="5" height="1.2" fill="var(--color-success)" />
        <rect x="9" y="20" width="6" height="2" />
        <rect x="6" y="21.5" width="12" height="1" />
      </>
    ),
  },
  {
    key: 'iot',
    label: 'IoT Device',
    group: 'Other',
    paths: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path
          d="M9 8.5C7.5 9.7 7.5 14.3 9 15.5M15 8.5c1.5 1.2 1.5 5.8 0 7M6.5 6c-3 2.5-3 9.5 0 12M17.5 6c3 2.5 3 9.5 0 12"
          stroke="currentColor"
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
        />
      </>
    ),
  },
];

export const ICON_BY_KEY: Record<string, IconDef> = AGENT_ICONS.reduce(
  (acc, icon) => {
    acc[icon.key] = icon;
    return acc;
  },
  {} as Record<string, IconDef>,
);

export const ICON_GROUPS: IconGroup[] = [
  'OS',
  'Network',
  'Compute',
  'Storage',
  'Industrial',
  'Other',
];

interface AgentIconProps {
  kind: string;
  size?: number;
  className?: string;
}

// Standalone <svg> renderer for picker / panel UI. Returns null when
// `kind` is not in the catalog so callers can fall back to a placeholder.
export function AgentIcon({ kind, size = 24, className }: AgentIconProps) {
  const def = ICON_BY_KEY[kind];
  if (!def) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      {def.paths}
    </svg>
  );
}

// Inner-paths renderer for embedding inside an existing SVG group (the
// MetroMap station). Wraps the paths in a nested <svg> with a viewBox so
// the icon scales to the requested pixel box and is centred at (0,0).
interface AgentIconNodeProps {
  kind: string;
  size: number;
}

export function AgentIconNode({ kind, size }: AgentIconNodeProps) {
  const def = ICON_BY_KEY[kind];
  if (!def) return null;
  const half = size / 2;
  return (
    <svg
      x={-half}
      y={-half}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      overflow="visible"
    >
      {def.paths}
    </svg>
  );
}
