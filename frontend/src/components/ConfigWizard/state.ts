import type { PeerTransport } from '../../api/types';

export type WizardStepId =
  | 'basic'
  | 'network'
  | 'tls'
  | 'peers'
  | 'socks5'
  | 'exit'
  | 'monitoring'
  | 'shell'
  | 'files'
  | 'management'
  | 'review';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type TlsMode = 'self_signed' | 'strict';
type MgmtMode = 'none' | 'public_only' | 'operator';

export interface WizardPeer {
  _id: string;
  transport: PeerTransport;
  address: string;
  path: string;
  expectedId: string;
}

// Several fields below (dataDir, listenPath, listenPlaintext,
// agentCertPem, agentKeyPem, tlsMtls, logLevel) no longer have a UI
// input — the wizard was trimmed to show only fields users actually
// change. They're kept here so yaml.ts keeps emitting the same
// defaults; operators who need a non-default can edit the downloaded
// YAML.
export interface WizardState {
  // Basic
  displayName: string;
  dataDir: string;

  // Network
  listenerEnabled: boolean;
  listenerTransport: PeerTransport;
  listenAddress: string;
  listenPath: string;
  listenPlaintext: boolean;

  // Advertise this listener as a public dial target via NodeInfo so other
  // mesh members can offer it in their config wizards. Opt-in per agent
  // because the bind address (e.g. 0.0.0.0:4433) is rarely the right
  // public dial target — operators behind NAT or a reverse proxy must
  // supply a publicly reachable host:port explicitly.
  advertiseEnabled: boolean;
  advertiseAddress: string;

  // TLS
  tlsMode: TlsMode;
  caPem: string;
  agentCertPem: string;
  agentKeyPem: string;
  tlsStrict: boolean;
  tlsMtls: boolean;

  // Peers
  peers: WizardPeer[];

  // SOCKS5
  socks5Enabled: boolean;
  socks5Address: string;

  // Exit
  exitEnabled: boolean;
  exitRoutes: string[];

  // Monitoring
  httpEnabled: boolean;
  httpAddress: string;
  httpTokenHash: string;
  logLevel: LogLevel;

  // Shell
  shellEnabled: boolean;
  shellWhitelist: string[];

  // File transfer
  fileTransferEnabled: boolean;
  fileTransferAllowedPaths: string[];

  // Management
  mgmtMode: MgmtMode;
  mgmtPublicKey: string;
  mgmtPrivateKey: string;
  mgmtSigningPublicKey: string;
  mgmtSigningPrivateKey: string;
  mgmtAcknowledged: boolean;
}

export function initialWizardState(): WizardState {
  return {
    displayName: '',
    dataDir: './data',

    listenerEnabled: true,
    listenerTransport: 'quic',
    listenAddress: '0.0.0.0:4433',
    listenPath: '/mesh',
    listenPlaintext: false,

    advertiseEnabled: true,
    advertiseAddress: '',

    tlsMode: 'self_signed',
    caPem: '',
    agentCertPem: '',
    agentKeyPem: '',
    tlsStrict: false,
    tlsMtls: false,

    peers: [],

    socks5Enabled: false,
    socks5Address: '127.0.0.1:1080',

    exitEnabled: false,
    exitRoutes: [],

    httpEnabled: false,
    httpAddress: ':8080',
    httpTokenHash: '',
    logLevel: 'info',

    shellEnabled: false,
    shellWhitelist: ['*'],

    fileTransferEnabled: false,
    fileTransferAllowedPaths: ['*'],

    mgmtMode: 'none',
    mgmtPublicKey: '',
    mgmtPrivateKey: '',
    mgmtSigningPublicKey: '',
    mgmtSigningPrivateKey: '',
    mgmtAcknowledged: false,
  };
}

export const ALL_STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'basic', label: 'Basics' },
  { id: 'network', label: 'Network' },
  { id: 'tls', label: 'TLS' },
  { id: 'peers', label: 'Peers' },
  { id: 'socks5', label: 'SOCKS5' },
  { id: 'exit', label: 'Exit routes' },
  { id: 'monitoring', label: 'Monitoring' },
  { id: 'shell', label: 'Shell' },
  { id: 'files', label: 'File transfer' },
  { id: 'management', label: 'Management key' },
  { id: 'review', label: 'Review & download' },
];
