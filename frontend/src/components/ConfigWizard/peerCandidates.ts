import type {
  AdvertisedListener,
  PeerEntry,
  PeerTransport,
  TopologyAgentInfo,
  TopologyConnection,
} from '../../api/types';
import { parsePeerAddress } from '../../util/peerAddress';

// One pickable "available peer" row in the wizard. Two sources feed it:
//   - mesh   — agent.advertised_listeners on a remote topology entry
//   - peer   — a connected outbound row in the local agent's peer table
// Mesh entries win on agent-id collision because they come straight
// from the remote agent's NodeInfo (authoritative dial target), while
// peer-table entries are how the *local* agent happens to reach it
// — possibly via a private hop the new agent can't replicate.
export type PeerCandidateSource = 'mesh' | 'peer';

export interface PeerCandidate {
  source: PeerCandidateSource;
  transport: PeerTransport;
  address: string; // host:port (no path)
  path: string; // for h2/ws; '' otherwise
  expectedId: string; // remote agent id (full hex)
  displayName?: string; // for label rendering; absent when source === 'peer' and remote_id was empty
  // Whether the underlying entity (agent or peer) is currently
  // reachable. Used only to gray out a row, not to filter — the
  // operator may legitimately want to dial an offline target.
  connected: boolean;
}

// Drop entries with bogus dial targets the user almost certainly
// can't actually reach. We do this defensively even though the agent
// is supposed to validate at config-load time.
function isUsableAddress(addr: string): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  if (lower.startsWith('0.0.0.0:')) return false;
  if (lower.startsWith('127.')) return false;
  if (lower.startsWith('[::]:')) return false;
  if (lower.startsWith('[::1]:')) return false;
  return true;
}

function fromAdvertised(
  agent: TopologyAgentInfo,
  listener: AdvertisedListener,
  liveShortIds: ReadonlySet<string>,
): PeerCandidate | null {
  if (!isUsableAddress(listener.address)) return null;
  // `agent.is_connected` is local-centric — it's true only when the local
  // agent has a *direct* peer link to this agent. For wizard purposes
  // that's the wrong question: a new agent dialing this listener cares
  // whether the target is alive *somewhere* in the mesh. We derive that
  // from the connections array — anyone appearing on either side of any
  // current link is reachable.
  const live = agent.is_local || agent.is_connected || liveShortIds.has(agent.short_id);
  return {
    source: 'mesh',
    transport: listener.transport,
    address: listener.address,
    path: listener.path || '',
    expectedId: agent.id,
    displayName: agent.display_name || agent.short_id,
    connected: live,
  };
}

function fromPeerEntry(p: PeerEntry): PeerCandidate | null {
  // Inbound entries carry the *remote socket* the peer dialed *us*
  // from — useless as a dial target.
  if (p.direction === 'inbound') return null;
  // Disconnected peer-table rows are still useful (operator may want
  // to seed a config with a known-good target that's flapping), but
  // skip them when there's no remote_id — without an id we can't
  // pin the new config to the right agent.
  const expectedId = p.remote_id || p.expected_id || '';
  if (!isUsableAddress(p.address) && !expectedId) return null;
  const { address, path } = parsePeerAddress(p.address);
  if (!isUsableAddress(address)) return null;
  return {
    source: 'peer',
    transport: p.transport,
    address,
    path,
    expectedId,
    connected: p.connected,
  };
}

// Stable comparator: mesh tier above peer tier (gives a more authoritative
// candidate the top slot), then by display name / address case-insensitively
// so polling refreshes don't reshuffle rows when the agent's topology dump
// returns members in a different order.
function compareCandidates(a: PeerCandidate, b: PeerCandidate): number {
  if (a.source !== b.source) return a.source === 'mesh' ? -1 : 1;
  const an = (a.displayName || a.address).toLowerCase();
  const bn = (b.displayName || b.address).toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  if (a.transport !== b.transport) return a.transport < b.transport ? -1 : 1;
  if (a.address !== b.address) return a.address < b.address ? -1 : 1;
  return 0;
}

// Merge: every remote agent's advertised listeners first (each becomes
// its own row — multi-transport agents can show twice), then peer-table
// rows that don't already have a candidate for the same agent id.
//
// We dedupe by `expectedId` because that's how the new generated config
// will pin the connection (`peers[].id`); two rows for the same agent id
// would just confuse the operator. Result is sorted for stable rendering.
export function buildPeerCandidates(
  topologyAgents: readonly TopologyAgentInfo[],
  peerEntries: readonly PeerEntry[],
  connections: readonly TopologyConnection[] = [],
): PeerCandidate[] {
  const out: PeerCandidate[] = [];
  const claimed = new Set<string>();
  const liveShortIds = new Set<string>();
  for (const c of connections) {
    if (c.from_agent) liveShortIds.add(c.from_agent);
    if (c.to_agent) liveShortIds.add(c.to_agent);
  }

  for (const agent of topologyAgents) {
    if (agent.is_local) continue;
    const listeners = agent.advertised_listeners || [];
    for (const l of listeners) {
      const c = fromAdvertised(agent, l, liveShortIds);
      if (!c) continue;
      out.push(c);
      claimed.add(agent.id);
    }
  }

  for (const p of peerEntries) {
    const c = fromPeerEntry(p);
    if (!c) continue;
    if (c.expectedId && claimed.has(c.expectedId)) continue;
    out.push(c);
    if (c.expectedId) claimed.add(c.expectedId);
  }

  out.sort(compareCandidates);
  return out;
}
