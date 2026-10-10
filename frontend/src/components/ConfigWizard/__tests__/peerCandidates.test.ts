import { describe, expect, it } from 'vitest';
import type { PeerEntry, TopologyAgentInfo } from '../../../api/types';
import { buildPeerCandidates } from '../peerCandidates';

function agent(over: Partial<TopologyAgentInfo>): TopologyAgentInfo {
  return {
    id: 'a'.repeat(32),
    short_id: 'aaaa',
    display_name: 'a',
    is_local: false,
    is_connected: true,
    roles: [],
    hostname: '',
    os: 'linux',
    arch: 'amd64',
    version: 'dev',
    uptime_hours: 0,
    ip_addresses: [],
    socks5_addr: '',
    udp_enabled: false,
    exit_routes: [],
    domain_routes: [],
    forward_listeners: [],
    forward_endpoints: [],
    ...over,
  };
}

function peer(over: Partial<PeerEntry>): PeerEntry {
  return {
    address: 'host:1',
    transport: 'h2',
    connected: true,
    persistent: false,
    dynamic: false,
    ...over,
  };
}

describe('buildPeerCandidates', () => {
  it('emits one candidate per advertised listener (multi-transport agent)', () => {
    const out = buildPeerCandidates(
      [
        agent({
          id: 'b'.repeat(32),
          display_name: 'B',
          advertised_listeners: [
            { transport: 'h2', address: 'b.example:443', path: '/mesh' },
            { transport: 'quic', address: 'b.example:4433' },
          ],
        }),
      ],
      [],
    );
    expect(out).toHaveLength(2);
    expect(out.map(c => c.transport)).toEqual(['h2', 'quic']);
    expect(out.every(c => c.source === 'mesh')).toBe(true);
  });

  it('skips the local agent even if it advertises a listener', () => {
    const out = buildPeerCandidates(
      [
        agent({
          is_local: true,
          id: 'l'.repeat(32),
          advertised_listeners: [{ transport: 'h2', address: 'me.local:443' }],
        }),
      ],
      [],
    );
    expect(out).toEqual([]);
  });

  it('topology entry wins over peer-table entry for the same agent id', () => {
    const id = 'c'.repeat(32);
    const out = buildPeerCandidates(
      [
        agent({
          id,
          display_name: 'C',
          advertised_listeners: [{ transport: 'h2', address: 'c.public:443', path: '/mesh' }],
        }),
      ],
      [peer({ address: 'https://c.private:8443/mesh', transport: 'h2', remote_id: id })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('mesh');
    expect(out[0].address).toBe('c.public:443');
  });

  it('falls back to the peer table when no listener is advertised', () => {
    const id = 'd'.repeat(32);
    const out = buildPeerCandidates(
      [agent({ id, display_name: 'D' /* no advertised_listeners */ })],
      [peer({ address: 'https://d.host:8443/mesh', transport: 'h2', remote_id: id })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('peer');
    expect(out[0].address).toBe('d.host:8443');
    expect(out[0].path).toBe('/mesh');
  });

  it('drops inbound peer entries (remote socket is not a dial target)', () => {
    const out = buildPeerCandidates(
      [],
      [
        peer({
          address: '1.2.3.4:54321',
          transport: 'h2',
          direction: 'inbound',
          remote_id: 'e'.repeat(32),
        }),
      ],
    );
    expect(out).toEqual([]);
  });

  it('drops bogus dial addresses (0.0.0.0, loopback)', () => {
    const out = buildPeerCandidates(
      [
        agent({
          id: 'f'.repeat(32),
          display_name: 'F',
          advertised_listeners: [
            { transport: 'h2', address: '0.0.0.0:443' },
            { transport: 'quic', address: '127.0.0.1:4433' },
            { transport: 'quic', address: '[::1]:4433' },
            { transport: 'quic', address: '[::]:4433' },
          ],
        }),
      ],
      [],
    );
    expect(out).toEqual([]);
  });

  it('returns a stable, alphabetised order regardless of input shuffle', () => {
    const make = (id: string, name: string) =>
      agent({
        id: id.repeat(32),
        display_name: name,
        advertised_listeners: [{ transport: 'h2', address: `${name}.host:443` }],
      });
    const expected = ['Apple', 'banana', 'Cherry'];
    const orderings = [
      [make('a', 'Apple'), make('b', 'banana'), make('c', 'Cherry')],
      [make('c', 'Cherry'), make('a', 'Apple'), make('b', 'banana')],
      [make('b', 'banana'), make('c', 'Cherry'), make('a', 'Apple')],
    ];
    for (const ordering of orderings) {
      const out = buildPeerCandidates(ordering, []);
      expect(out.map(c => c.displayName)).toEqual(expected);
    }
  });

  it('preserves disconnected mesh members but tags them offline', () => {
    const out = buildPeerCandidates(
      [
        agent({
          id: 'g'.repeat(32),
          display_name: 'G',
          is_connected: false,
          advertised_listeners: [{ transport: 'h2', address: 'g.host:443' }],
        }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].connected).toBe(false);
  });

  it('marks an agent online when reachable via transit even though is_connected is false', () => {
    // Models the LAMP-via-kreata case: local agent has no direct link
    // to LAMP but LAMP has a connection to kreata, so it is alive in
    // the mesh and the wizard should say so.
    const out = buildPeerCandidates(
      [
        agent({
          id: 'h'.repeat(32),
          short_id: 'hhhh',
          display_name: 'LAMP',
          is_connected: false,
          advertised_listeners: [{ transport: 'ws', address: 'lamp.host:443', path: '/mesh' }],
        }),
      ],
      [],
      [
        {
          from_agent: 'kkkk',
          to_agent: 'hhhh',
          is_direct: false,
          transport: 'ws',
          rtt_ms: 47,
          unresponsive: false,
        },
      ],
    );
    expect(out).toHaveLength(1);
    expect(out[0].connected).toBe(true);
  });
});
