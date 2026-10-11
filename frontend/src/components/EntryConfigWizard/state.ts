export const ENTRY_DEFAULT_WS_PATH = '/socks5';
export const ENTRY_DEFAULT_ADMIN_LISTEN = '127.0.0.1:48088';

export type EntryWizardStepId = 'tun' | 'socks5' | 'routes' | 'admin' | 'review';

export type EntryLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type EntryLogFormat = 'json' | 'console';
export type EntrySocks5Transport = 'tcp' | 'websocket';

export interface EntryRoute {
  _id: string;
  destination: string;
  comment: string;
  enabled: boolean;
}

// Several fields below (tunName, tunMtu, tunIPv6Enabled, tunAddress6,
// logLevel, logFormat) no longer have a UI input — the wizard was
// trimmed to show only fields users actually change. They're kept here
// so yaml.ts keeps emitting the same defaults; operators who need a
// non-default can edit the downloaded YAML.
export interface EntryWizardState {
  // TUN
  tunName: string;
  tunMtu: number;
  tunAddress: string;
  tunIPv6Enabled: boolean;
  tunAddress6: string;

  // SOCKS5
  socks5Server: string;
  socks5AuthEnabled: boolean;
  socks5Username: string;
  socks5Password: string;
  socks5Transport: EntrySocks5Transport;
  socks5WSPath: string;

  // Routes — autoroutes ride the SOCKS5 connection route-watch stream, so no
  // separate dashboard endpoint or token is needed; `enabled` is the only knob.
  autoroutesEnabled: boolean;
  routes: EntryRoute[];

  // Admin — loopback-only, unauthenticated HTTP dashboard + JSON API.
  adminEnabled: boolean;
  adminListen: string;

  // Logging
  logLevel: EntryLogLevel;
  logFormat: EntryLogFormat;
}

// Optional operator-configured default for the SOCKS5 server field,
// sourced from Muti Metroo Manager's Settings dialog.
export interface EntryWizardSeed {
  socksAddress?: string;
}

export function initialEntryWizardState(seed?: EntryWizardSeed): EntryWizardState {
  return {
    tunName: 'mutiauk',
    tunMtu: 1400,
    tunAddress: '10.200.200.1/24',
    tunIPv6Enabled: false,
    tunAddress6: 'fd00:200::1/64',

    socks5Server: seed?.socksAddress?.trim() || '127.0.0.1:1080',
    socks5AuthEnabled: false,
    socks5Username: '',
    socks5Password: '',
    socks5Transport: 'tcp',
    socks5WSPath: ENTRY_DEFAULT_WS_PATH,

    autoroutesEnabled: true,
    routes: [],

    adminEnabled: true,
    adminListen: ENTRY_DEFAULT_ADMIN_LISTEN,

    logLevel: 'info',
    logFormat: 'json',
  };
}

export const ENTRY_STEPS: { id: EntryWizardStepId; label: string }[] = [
  { id: 'tun', label: 'TUN interface' },
  { id: 'socks5', label: 'SOCKS5 proxy' },
  { id: 'routes', label: 'Routes' },
  { id: 'admin', label: 'Admin interface' },
  { id: 'review', label: 'Review & download' },
];
