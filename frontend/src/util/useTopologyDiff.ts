import { useEffect, useRef, useState } from 'react';
import type {
  MeshTestResponse,
  TopologyAgentInfo,
  TopologyConnection,
  TopologyResponse,
} from '../api/types';

export type TickerEventKind =
  | 'peer-joined'
  | 'peer-left'
  | 'connection-up'
  | 'connection-down'
  | 'route-advertised'
  | 'route-revoked'
  | 'mesh-test-recovered'
  | 'mesh-test-degraded';

export interface TickerEvent {
  id: string;
  ts: number;
  kind: TickerEventKind;
  text: string;
}

interface DiffOptions {
  capacity?: number;
  newConnectionTtlMs?: number;
}

interface DiffResult {
  events: TickerEvent[];
  newConnectionKeys: Set<string>;
}

const DEFAULT_CAPACITY = 200;
const DEFAULT_TTL_MS = 1500;

// Undirected key for a connection — the agent emits from_agent/to_agent in a
// non-deterministic order across polls for links it discovers via NODE_INFO,
// so we canonicalise by sorting the endpoint pair.
export function connKey(c: Pick<TopologyConnection, 'from_agent' | 'to_agent'>): string {
  return c.from_agent < c.to_agent
    ? `${c.from_agent}|${c.to_agent}`
    : `${c.to_agent}|${c.from_agent}`;
}

function agentLabel(a: TopologyAgentInfo): string {
  return a.display_name || a.hostname || a.short_id;
}

function agentLabelById(prev: Map<string, TopologyAgentInfo>, id: string): string {
  const a = prev.get(id);
  return a ? agentLabel(a) : id.slice(0, 6);
}

function diffStringSet(
  prev: string[] | undefined,
  next: string[] | undefined,
): { added: string[]; removed: string[] } {
  const p = new Set(prev ?? []);
  const n = new Set(next ?? []);
  const added: string[] = [];
  const removed: string[] = [];
  for (const v of n) if (!p.has(v)) added.push(v);
  for (const v of p) if (!n.has(v)) removed.push(v);
  return { added, removed };
}

let nextId = 0;

export function useTopologyDiff(
  topology: TopologyResponse | null,
  meshTest: MeshTestResponse | null,
  options: DiffOptions = {},
): DiffResult {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const ttl = options.newConnectionTtlMs ?? DEFAULT_TTL_MS;

  const prevTopologyRef = useRef<TopologyResponse | null>(null);
  const prevDegradedRef = useRef<boolean | null>(null);

  const [events, setEvents] = useState<TickerEvent[]>([]);
  const [newConnectionKeys, setNewConnectionKeys] = useState<Set<string>>(new Set());

  const appendCapped = (incoming: TickerEvent[]) => {
    if (incoming.length === 0) return;
    setEvents(prev => {
      const merged = prev.concat(incoming);
      return merged.length > capacity ? merged.slice(-capacity) : merged;
    });
  };

  useEffect(() => {
    if (!topology) return;
    const prev = prevTopologyRef.current;
    prevTopologyRef.current = topology;
    if (!prev) return;

    const now = Date.now();
    const prevAgentMap = new Map(prev.agents.map(a => [a.id, a]));
    const nextAgentMap = new Map(topology.agents.map(a => [a.id, a]));
    const prevConnSet = new Set(prev.connections.map(connKey));
    const nextConnSet = new Set(topology.connections.map(connKey));
    const queued: TickerEvent[] = [];
    const newKeys: string[] = [];

    for (const a of topology.agents) {
      if (a.is_local) continue;
      if (!prevAgentMap.has(a.id)) {
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'peer-joined',
          text: `peer joined: ${agentLabel(a)}`,
        });
        continue;
      }
      const before = prevAgentMap.get(a.id)!;
      const exit = diffStringSet(before.exit_routes, a.exit_routes);
      for (const r of exit.added)
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'route-advertised',
          text: `route advertised: ${r} via ${agentLabel(a)}`,
        });
      for (const r of exit.removed)
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'route-revoked',
          text: `route revoked: ${r} via ${agentLabel(a)}`,
        });
      const dom = diffStringSet(before.domain_routes, a.domain_routes);
      for (const r of dom.added)
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'route-advertised',
          text: `domain route advertised: ${r} via ${agentLabel(a)}`,
        });
      for (const r of dom.removed)
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'route-revoked',
          text: `domain route revoked: ${r} via ${agentLabel(a)}`,
        });
    }
    for (const a of prev.agents) {
      if (a.is_local) continue;
      if (!nextAgentMap.has(a.id)) {
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'peer-left',
          text: `peer left: ${agentLabel(a)}`,
        });
      }
    }

    for (const c of topology.connections) {
      const key = connKey(c);
      if (!prevConnSet.has(key)) {
        newKeys.push(key);
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'connection-up',
          text: `link up: ${agentLabelById(prevAgentMap, c.from_agent)} ↔ ${agentLabelById(nextAgentMap, c.to_agent)} (${c.transport})`,
        });
      }
    }
    for (const c of prev.connections) {
      const key = connKey(c);
      if (!nextConnSet.has(key)) {
        queued.push({
          id: `e${nextId++}`,
          ts: now,
          kind: 'connection-down',
          text: `link down: ${agentLabelById(prevAgentMap, c.from_agent)} ↔ ${agentLabelById(prevAgentMap, c.to_agent)}`,
        });
      }
    }

    appendCapped(queued);

    if (newKeys.length > 0) {
      setNewConnectionKeys(prev => {
        const next = new Set(prev);
        for (const k of newKeys) next.add(k);
        return next;
      });
      // Fire-and-forget per-batch expiry; cleanup on unmount via the effect's
      // own remount cycle — orphaned timeouts during fast remounts at most
      // dispatch a no-op setState on a stale closure.
      setTimeout(() => {
        setNewConnectionKeys(prev => {
          if (prev.size === 0) return prev;
          const next = new Set(prev);
          let changed = false;
          for (const k of newKeys) if (next.delete(k)) changed = true;
          return changed ? next : prev;
        });
      }, ttl);
    }
  }, [topology, capacity, ttl]);

  useEffect(() => {
    if (!meshTest) return;
    const remote = (meshTest.results ?? []).filter(r => !r.is_local);
    if (remote.length === 0) return;
    const isDegraded = remote.some(r => !r.reachable);
    const wasDegraded = prevDegradedRef.current;
    prevDegradedRef.current = isDegraded;
    if (wasDegraded === null || wasDegraded === isDegraded) return;
    const ts = Date.now();
    const unreachable = remote.filter(r => !r.reachable).length;
    appendCapped([
      isDegraded
        ? {
            id: `e${nextId++}`,
            ts,
            kind: 'mesh-test-degraded',
            text: `mesh test: ${unreachable} of ${remote.length} peers unreachable`,
          }
        : {
            id: `e${nextId++}`,
            ts,
            kind: 'mesh-test-recovered',
            text: `mesh test: all ${remote.length} peers reachable`,
          },
    ]);
  }, [meshTest, capacity]);

  return { events, newConnectionKeys };
}
