export interface Stats {
  peer_count: number;
  stream_count: number;
  route_count: number;
  socks5_running: boolean;
  exit_handler_running: boolean;
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

export interface SleepStatusResponse {
  state: 'AWAKE' | 'SLEEPING' | 'POLLING';
  enabled: boolean;
}

export interface RouteManageRequest {
  action: 'add' | 'remove' | 'list';
  network?: string;
  metric?: number;
}

export interface RouteManageResponse {
  status: string;
  routes?: { network: string; metric: number }[];
  message?: string;
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
  error?: string;
}

// Shell binary protocol message types (must match internal/shell/messages.go)
export const MSG_META    = 0x01;
export const MSG_ACK     = 0x02;
export const MSG_STDIN   = 0x03;
export const MSG_STDOUT  = 0x04;
export const MSG_STDERR  = 0x05;
export const MSG_RESIZE  = 0x06;
export const MSG_SIGNAL  = 0x07;
export const MSG_EXIT    = 0x08;
export const MSG_ERROR   = 0x09;

// Shell error codes
export const ERR_SHELL_DISABLED        = 20;
export const ERR_FILE_TRANSFER_DENIED  = 12;

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
