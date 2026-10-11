import type { PeerTransport } from '../api/types';

// Muti Metroo stores h2/ws peers as URLs (e.g. "wss://host:port/mesh") and QUIC peers
// as bare "host:port". These helpers are the symmetric encode/decode.

export function parsePeerAddress(addr: string): { address: string; path: string } {
  try {
    if (/^[a-zA-Z]+:\/\//.test(addr)) {
      const u = new URL(addr);
      return { address: u.host, path: u.pathname || '' };
    }
  } catch {
    /* not a URL */
  }
  return { address: addr, path: '' };
}

export function formatPeerAddress(transport: PeerTransport, address: string, path: string): string {
  if (!path) return address;
  const scheme = transport === 'ws' ? 'wss' : 'https';
  return `${scheme}://${address}${path}`;
}

// Ensure an HTTP path (h2/ws) has a leading slash; empty stays empty.
export function normalizePath(p: string): string {
  if (!p) return '';
  return p.startsWith('/') ? p : '/' + p;
}
