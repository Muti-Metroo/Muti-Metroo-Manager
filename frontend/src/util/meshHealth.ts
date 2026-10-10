import type { MeshTestResponse, TopologyResponse } from '../api/types';

export type MeshStatus = 'idle' | 'ok' | 'degraded' | 'down';

export interface MeshHealth {
  status: MeshStatus;
  peerCount: number;
  total: number;
  reachable: number;
  unreachable: number;
}

export function summarizeMeshHealth(
  topology: TopologyResponse | null,
  meshTest: MeshTestResponse | null,
): MeshHealth {
  const peerCount = (topology?.agents ?? []).filter(a => !a.is_local).length;
  const remote = (meshTest?.results ?? []).filter(r => !r.is_local);
  const reachable = remote.filter(r => r.reachable).length;
  const unreachable = remote.length - reachable;

  const status: MeshStatus =
    peerCount === 0 || remote.length === 0
      ? 'idle'
      : unreachable === 0
        ? 'ok'
        : reachable === 0
          ? 'down'
          : 'degraded';

  return { status, peerCount, total: remote.length, reachable, unreachable };
}
