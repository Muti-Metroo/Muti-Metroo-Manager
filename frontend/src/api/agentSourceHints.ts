import type { TopologyAgentInfo } from './types';

const WILDCARDS = new Set(['', '0.0.0.0', '::', '[::]']);

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isIpLiteral(s: string): boolean {
  if (IPV4_RE.test(s)) {
    return s.split('.').every(o => {
      const n = Number(o);
      return n >= 0 && n <= 255;
    });
  }
  return IPV6_RE.test(s) && s.includes(':');
}

// Strip port from "host:port" or "[v6]:port". Returns the host portion,
// or the input unchanged if no port is present. Bracketed IPv6 always
// has its brackets removed.
function hostOf(addr: string): string {
  const s = addr.trim();
  if (!s) return '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    return end === -1 ? s : s.slice(1, end);
  }
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return s;
  // If there are multiple colons and no brackets, it's a bare IPv6 literal —
  // don't treat the trailing chunk as a port.
  if (s.indexOf(':') !== lastColon) return s;
  return s.slice(0, lastColon);
}

// Returns a deduplicated, ordered list of IP literals the operator may
// reasonably want to use as a route source binding. All values come
// from data already present in /api/dashboard or /api/topology — no
// extra agent endpoint is required. Free-text input remains available
// in the dialog for IPs not enumerated here.
export function deriveSourceIpHints(agent: TopologyAgentInfo): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const host = hostOf(raw);
    if (WILDCARDS.has(host)) return;
    if (!isIpLiteral(host)) return;
    if (seen.has(host)) return;
    seen.add(host);
    out.push(host);
  };
  for (const ip of agent.ip_addresses || []) add(ip);
  for (const l of agent.advertised_listeners || []) add(l.address);
  add(agent.socks5_addr);
  return out;
}
