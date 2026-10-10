export interface Stats {
  peer_count: number;
  stream_count: number;
  route_count: number;
  socks5_running: boolean;
  exit_handler_running: boolean;
  can_sign_management?: boolean;
  accepts_signed_management?: boolean;
}

// Operator-editable settings persisted by Muti Metroo Manager. Empty strings mean
// "no override — fall back to the browser location". Shape matches
// store.Settings on the Go side (see internal/store/store.go).
export interface AppSettings {
  api_address: string;
  socks_address: string;
  // UI sound effects. Default true server-side. When `sounds_locked`
  // is true the operator disabled them via -no-sounds; the client
  // greys the toggle and never plays sounds.
  sounds_enabled: boolean;
  sounds_locked?: boolean;
}

// Per-agent operator-set metadata persisted in muti-metroo-manager.db. Empty
// strings mean "no override". A missing entry in AgentMetadataMap is
// equivalent to {note: '', icon: ''}. The `icon` value is a key from
// the frontend icon catalog (see components/MetroMap/agentIcons.tsx);
// unknown keys fall back to the default circle.
export interface AgentMeta {
  note: string;
  icon: string;
  // Comma-separated network membership identifiers (no spaces/commas in a
  // token). Empty means the agent belongs to no network. Drives the
  // topology map's network boxes.
  networks: string;
}
export type AgentMetadataMap = Record<string, AgentMeta>;
export const EMPTY_AGENT_META: AgentMeta = { note: '', icon: '', networks: '' };

// Operator-set display-name overrides for network boxes, keyed by network
// identifier. A missing entry means "show the identifier as the name".
export type NetworkNameMap = Record<string, string>;

// Operator-placed map positions keyed by agent short_id (layout coords).
export type PositionMap = Record<string, { x: number; y: number }>;

// Shape returned by Muti Metroo Manager's OWN /healthz (not the proxied agent health).
// `version` is the Muti Metroo Manager binary that embeds and serves this UI, so it's
// the truth for "is the deployed app up to date".
export interface ServerHealth {
  status: string;
  version: string;
  agent_reachable: boolean;
}

// Shape returned by /healthz. Superset of Stats with status fields.
export interface HealthResponse {
  status: string;
  running: boolean;
  peer_count?: number;
  stream_count?: number;
  route_count?: number;
  socks5_running?: boolean;
  exit_handler_running?: boolean;
  can_sign_management?: boolean;
  accepts_signed_management?: boolean;
}

export interface DashboardRouteInfo {
  network: string;
  route_type: string;
  origin: string;
  origin_id: string;
  hop_count: number;
  path_display: string[];
  tcp: boolean;
  udp: boolean;
  path_ids: string[];
  comment?: string;
  // Only populated for routes the responding agent originates; never
  // advertised to peers. Empty/missing means no source binding.
  source_ip?: string;
  // Egress NIC for this route. Settable on any platform; on Linux + root
  // it pins the NIC via SO_BINDTODEVICE, elsewhere the agent binds a source
  // address picked from the interface. Same local-only visibility rules as
  // source_ip.
  interface?: string;
}

export interface DashboardPortForwardRouteInfo {
  key: string;
  ingress_agent: string;
  ingress_agent_id: string;
  listener_address: string;
  exit_agent: string;
  exit_agent_id: string;
  target: string;
  hop_count: number;
  path_display: string[];
  path_ids: string[];
}

export interface DashboardPeerInfo {
  id: string;
  short_id: string;
  display_name: string;
  state: string;
  rtt_ms: number;
  unresponsive: boolean;
  is_dialer: boolean;
}

export interface DashboardDomainRouteInfo {
  pattern: string;
  is_wildcard: boolean;
  origin: string;
  origin_id: string;
  hop_count: number;
  path_display: string[];
  path_ids: string[];
  tcp: boolean;
  udp: boolean;
}

export interface DashboardResponse {
  agent: TopologyAgentInfo;
  stats: Stats;
  peers: DashboardPeerInfo[] | null;
  routes: DashboardRouteInfo[] | null;
  domain_routes: DashboardDomainRouteInfo[] | null;
  forward_routes: DashboardPortForwardRouteInfo[] | null;
  mesh_hosts?: MeshHost[] | null;
  // Active TLD suffixes (without leading dots, e.g. ["mesh", "muti-metroo.alt"])
  // that mesh-host names must end with. Multi-level allowed. Absent on
  // older agents.
  mesh_hosts_suffixes?: string[];
}

// One listener this agent has chosen to advertise as a dial target,
// flooded across the mesh via NodeInfo. Operators opt in per-listener
// in the agent config (`listeners[].advertise.{address,path}`); agents
// behind NAT or with internal-only listeners simply omit it. Address
// is "host:port" with no path; `path` is meaningful only for h2/ws.
// Older agents (pre-feature) emit no field at all — consumers must
// treat the array as optional.
export interface AdvertisedListener {
  transport: PeerTransport;
  address: string;
  path?: string;
}

export interface TopologyAgentInfo {
  id: string;
  short_id: string;
  display_name: string;
  is_local: boolean;
  is_connected: boolean;
  roles: string[];
  hostname: string;
  os: string;
  arch: string;
  version: string;
  pid?: number;
  uptime_hours: number;
  ip_addresses: string[];
  socks5_addr: string;
  udp_enabled: boolean;
  exit_routes: string[];
  domain_routes: string[];
  forward_listeners: string[];
  forward_endpoints: string[];
  shells?: string[];
  shell_enabled?: boolean;
  file_transfer_enabled?: boolean;
  icmp_enabled?: boolean;
  advertised_listeners?: AdvertisedListener[];
}

export const isWindowsAgent = (agent: Pick<TopologyAgentInfo, 'os'>): boolean =>
  agent.os === 'windows';

export interface TopologyConnection {
  from_agent: string;
  to_agent: string;
  is_direct: boolean;
  transport: string;
  rtt_ms: number;
  unresponsive: boolean;
  // ShortID of the dialing agent. Empty/missing means direction is unknown
  // (e.g. a route-path hop where neither endpoint's NodeInfo was available).
  dialer?: string;
}

export interface TopologyResponse {
  local_agent: TopologyAgentInfo;
  agents: TopologyAgentInfo[];
  connections: TopologyConnection[];
}

export interface MeshTestResult {
  agent_id: string;
  short_id: string;
  display_name: string;
  reachable: boolean;
  is_local: boolean;
  response_time_ms: number;
  error: string;
}

export interface MeshTestResponse {
  local_agent: string;
  test_time: string;
  duration_ms: number;
  total_count: number;
  reachable_count: number;
  results: MeshTestResult[];
}

// --- Agent management types ---

// A single IP address assigned to one of the agent's up interfaces.
// Used to populate the route source-IP picker. Mirrors the agent's
// sysinfo.InterfaceAddr.
export interface InterfaceAddr {
  interface: string;
  ip: string;
  family: 'ipv4' | 'ipv6';
  loopback: boolean;
  link_local: boolean;
  global: boolean;
}

export interface InterfacesResponse {
  addresses: InterfaceAddr[];
}

export interface SleepStatusResponse {
  state: 'AWAKE' | 'SLEEPING' | 'POLLING';
  enabled: boolean;
}

export interface RouteManageRequest {
  action: 'add' | 'remove' | 'list' | 'set_comment' | 'set_source_ip' | 'set_interface';
  network?: string;
  metric?: number;
  comment?: string;
  // Empty string clears the binding. Validated server-side: must parse
  // as IP literal whose family matches the CIDR.
  source_ip?: string;
  // Empty string clears. Accepted on any platform; the server only rejects
  // an explicit source_ip that isn't assigned to this interface unless the
  // agent is Linux + root (the off-interface SO_BINDTODEVICE case).
  interface?: string;
  // Only used by `list`. Older agents ignore this field and always
  // return dynamic-only entries (without a `dynamic` flag); see the
  // RoutesTab fallback that detects this.
  scope?: 'dynamic' | 'all';
}

export interface RouteManageResponse {
  status: string;
  routes?: {
    network: string;
    metric: number;
    comment?: string;
    source_ip?: string;
    interface?: string;
    dynamic?: boolean;
  }[];
  message?: string;
}

// --- Route trace (POST /route/trace on the Muti Metroo agent) ---
//
// Mirrors RouteTraceResult and friends in Muti Metroo's
// internal/health/route_trace.go. The `socks` / `tun` view fields are
// additive — older agents return only the legacy fields and the UI
// falls back to deriving the per-context views from `ips` / `domain`.

export interface RouteTraceCandidate {
  network: string;
  prefix_len: number;
  metric: number;
  origin: string;
  origin_name?: string;
  next_hop: string;
  next_hop_name?: string;
  hop_count: number;
  last_update?: string;
  winner: boolean;
  reason?: string;
}

export interface RouteTraceIP {
  ip: string;
  candidates?: RouteTraceCandidate[];
  no_match?: boolean;
}

export interface RouteTraceDomain {
  matched: boolean;
  pattern?: string;
  is_wildcard?: boolean;
  metric?: number;
  origin?: string;
  origin_name?: string;
  next_hop?: string;
  next_hop_name?: string;
  hop_count?: number;
}

export interface RouteTraceSkipped {
  network: string;
  reason: string;
}

// One per simulated routing surface (SOCKS5 ingress, TUN device).
// Future-shaped — populated by Phase 2 of the Muti Metroo agent. When absent,
// the UI derives an approximation from the legacy `ips` / `domain`
// fields.
export interface RouteTraceView {
  resolution: 'ip' | 'domain' | 'mesh-host' | 'system' | 'unresolved' | string;
  resolved_ips?: string[];
  winner?: RouteTraceCandidate;
  skipped?: RouteTraceSkipped[];
  note?: string;
}

export interface RouteTraceResult {
  status: string;
  dest: string;
  hostname?: string;
  resolver_ok: boolean;
  resolution?: 'ip' | 'mesh' | 'system' | string;
  ips?: RouteTraceIP[];
  domain?: RouteTraceDomain;
  socks?: RouteTraceView;
  tun?: RouteTraceView;
  error?: string;
}

export interface ForwardManageRequest {
  action: 'add' | 'remove' | 'list';
  key?: string;
  address?: string;
  max_connections?: number;
}

export interface ForwardListenerEntry {
  key: string;
  address: string;
  max_connections: number;
  dynamic: boolean;
}

export interface ForwardManageResponse {
  status: string;
  listeners?: ForwardListenerEntry[];
  message?: string;
}

export interface ForwardEndpointManageRequest {
  action: 'add' | 'remove' | 'list';
  key?: string;
  target?: string;
}

export interface ForwardEndpointEntry {
  key: string;
  target: string;
  dynamic: boolean;
}

// Targets advertised by ephemeral expose endpoints (Muti Metroo expose sessions,
// served over the SOCKS5 CmdExpose stream) carry this prefix instead of a
// host:port. The constant mirrors `LabelPrefix` in the agent's
// `internal/expose/protocol.go`.
export const EXPOSE_TARGET_PREFIX = 'expose:';

export function isAttachedTarget(target: string): boolean {
  return target.startsWith(EXPOSE_TARGET_PREFIX);
}

export interface ForwardEndpointManageResponse {
  status: string;
  endpoints?: ForwardEndpointEntry[];
  message?: string;
}

export type PeerTransport = 'quic' | 'h2' | 'ws';
export const PEER_TRANSPORTS: readonly PeerTransport[] = ['quic', 'h2', 'ws'];

// Whether this transport uses an HTTP path (h2/ws do; QUIC does not).
export function transportHasHttpPath(t: PeerTransport): boolean {
  return t === 'h2' || t === 'ws';
}

export interface PeerManageRequest {
  action: 'add' | 'remove' | 'list';
  address?: string;
  transport?: PeerTransport;
  id?: string;
  // Per-peer TCP keepalive override as a Go duration ("30s", "2m").
  // Omitted or empty inherits the agent's global transport setting; the
  // agent rejects a negative value. Only meaningful on `add`.
  tcp_keepalive?: string;
}

export interface PeerEntry {
  address: string;
  transport: PeerTransport;
  expected_id?: string;
  remote_id?: string;
  connected: boolean;
  persistent: boolean;
  dynamic: boolean;
  // Present as "inbound" for accepted (peer-dialed-us) connections.
  // Omitted for outbound entries this agent dials.
  direction?: 'inbound';
}

export interface PeerManageResponse {
  status: string;
  peers?: PeerEntry[];
  message?: string;
}

// Dynamic transport listeners: the QUIC/H2/WS sockets an agent binds to
// accept inbound peer connections. Managed via /listeners/manage,
// mirroring the peer-management surface.
export interface ListenerManageRequest {
  action: 'add' | 'remove' | 'list';
  transport?: PeerTransport;
  address?: string;
  // HTTP path for h2/ws listeners (e.g. /mesh).
  path?: string;
  // ws-only: bind without TLS (reverse-proxy deployments).
  plaintext?: boolean;
  // Optional public dial target advertised to the mesh.
  advertise_address?: string;
  advertise_path?: string;
  advertise_transport?: PeerTransport;
}

export interface ListenerEntry {
  transport: PeerTransport;
  address: string;
  path?: string;
  plaintext: boolean;
  advertise_address?: string;
  // false for config-file listeners (cannot be removed/replaced),
  // true for runtime-added ones.
  dynamic: boolean;
}

export interface ListenerManageResponse {
  status: string;
  listeners?: ListenerEntry[];
  message?: string;
}

// Mesh-host registry: hostname → IPv4/IPv6 mappings served to Mutiauk
// over /api/dashboard for local DNS resolution. Managed via /hosts/manage
// on the local agent only — no per-agent variant exists.
export interface MeshHost {
  name: string;
  ipv4?: string;
  ipv6?: string;
  comment?: string;
}

export interface MeshHostManageRequest {
  action: 'add' | 'remove' | 'list';
  name?: string;
  ipv4?: string;
  ipv6?: string;
  comment?: string;
}

export interface MeshHostManageResponse {
  // Active TLD suffix set after the operation, used by the client to
  // validate hostnames. Older agents return only `hosts`.
  suffixes?: string[];
  hosts: MeshHost[];
}

export interface MeshHostSuffixManageRequest {
  action: 'add' | 'remove' | 'list';
  // Single label ("mesh") or multi-level ("muti-metroo.alt"). Required for
  // add/remove, ignored on list.
  suffix?: string;
}

export interface MeshHostSuffixManageResponse {
  // Active TLD set after the operation.
  suffixes: string[];
}

export interface ProbeRequest {
  address: string;
  transport?: PeerTransport;
  path?: string;
  timeout_ms?: number;
}

export interface ProbeResponse {
  success: boolean;
  transport?: PeerTransport;
  address?: string;
  remote_id?: string;
  remote_display_name?: string;
  rtt_ms?: number;
  error?: string;
}

// --- Setup defaults (used by config wizard) ---

export interface SetupDefaultsTLS {
  ca_pem: string;
  strict: boolean;
  mtls: boolean;
  self_signed: boolean;
}

export interface SetupDefaultsManagement {
  enabled: boolean;
  public_key: string;
  has_private_key: boolean;
  signing_public_key: string;
  has_signing_private_key: boolean;
}

export interface SetupDefaultsListener {
  transport: '' | PeerTransport;
  address: string;
  path: string;
  plaintext: boolean;
}

export interface SetupDefaultsSuggestedPeer {
  address: string;
  transport: PeerTransport;
  path: string;
  expected_id: string;
}

export interface SetupDefaultsHTTP {
  enabled: boolean;
  token_hash: string;
}

export interface SetupDefaultsShell {
  enabled: boolean;
  whitelist: string[];
}

export interface SetupDefaultsFileTransfer {
  enabled: boolean;
  allowed_paths: string[];
}

export interface SetupDefaultsResponse {
  agent_id: string;
  display_name: string;
  version: string;
  tls: SetupDefaultsTLS;
  management: SetupDefaultsManagement;
  listener: SetupDefaultsListener;
  suggested_peer: SetupDefaultsSuggestedPeer;
  // Optional — absent on older Muti Metroo agents that only return the original fields.
  http?: SetupDefaultsHTTP;
  shell?: SetupDefaultsShell;
  file_transfer?: SetupDefaultsFileTransfer;
}

export interface AgentCapabilities {
  shell: boolean | null;
  fileTransfer: boolean | null;
  icmp: boolean | null;
}

// --- File browse types ---

export interface FileBrowseEntry {
  name: string;
  size: number;
  mode: string;
  mod_time: string;
  is_dir: boolean;
  is_symlink?: boolean;
  link_target?: string;
}

export interface FileBrowseListResponse {
  path: string;
  entries: FileBrowseEntry[];
  total: number;
  truncated: boolean;
  error?: string;
}

export interface FileBrowseRootsResponse {
  roots: string[];
  wildcard: boolean;
  home?: string;
  error?: string;
}

// Shape of /api/downloads/manifest. The Downloads tab is rendered only
// when this fetch returns 200 — a 404 (no bundle deployed) hides it.
export interface DownloadsManifestFile {
  name: string; // archive name (used in /api/downloads/file/<name>)
  download_name: string; // friendly filename the browser saves as (e.g. "muti-metroo.exe")
  category: 'agent' | 'agent-dll' | 'entry' | 'manual';
  os: string; // human label: "macOS" | "Linux" | "Windows" | ""
  arch: string; // "amd64" | "arm64" | ""
  type: string; // "executable" | "dll" | ""
  size: number;
  sha256: string;
  version: string;
}
export interface DownloadsManifest {
  muti_metroo_version: string;
  entry_version: string;
  generated_at: string;
  files: DownloadsManifestFile[];
}

// Shell binary protocol message types (must match internal/shell/messages.go)
export const MSG_META = 0x01;
export const MSG_ACK = 0x02;
export const MSG_STDIN = 0x03;
export const MSG_STDOUT = 0x04;
export const MSG_STDERR = 0x05;
export const MSG_RESIZE = 0x06;
export const MSG_SIGNAL = 0x07;
export const MSG_EXIT = 0x08;
export const MSG_ERROR = 0x09;
// Client→Agent, no payload: no more stdin will follow. The web client always
// allocates a PTY, where the line discipline turns Ctrl+D into EOF, so this is
// only meaningful for the non-TTY streaming sessions the CLI opens. Mirrored
// here so the table stays a faithful copy of the agent's messages.go.
export const MSG_STDIN_CLOSE = 0x0a;

// Shell error codes
export const ERR_SHELL_DISABLED = 20;
export const ERR_SHELL_AUTH_REQUIRED = 21;
export const ERR_SHELL_INVALID_CREDS = 22;
export const ERR_FILE_TRANSFER_DENIED = 12;

export interface ShellTTYSettings {
  rows: number;
  cols: number;
  term?: string;
}

export interface ShellMeta {
  command: string;
  args?: string[];
  tty?: ShellTTYSettings;
}
