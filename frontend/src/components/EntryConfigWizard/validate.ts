import { validateHostPort } from '../../util/validate';

export { validateCIDR, validateHostPort, validatePath } from '../../util/validate';

export function validateIPv4CIDR(value: string): string | null {
  const v = value.trim();
  if (!v) return 'IPv4 CIDR is required';
  if (v.includes(':')) return 'Expected an IPv4 address (no colons)';
  const slash = v.indexOf('/');
  if (slash === -1) return 'CIDR must include /prefix';
  const addr = v.slice(0, slash);
  const mask = v.slice(slash + 1);
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return 'Invalid IPv4 address';
  if (
    addr
      .split('.')
      .map(Number)
      .some(n => n < 0 || n > 255)
  )
    return 'IPv4 octets must be 0-255';
  if (!/^\d+$/.test(mask)) return 'Prefix must be numeric';
  const m = Number(mask);
  if (m < 0 || m > 32) return 'IPv4 prefix must be 0-32';
  return null;
}

// Validates admin.listen. Mirrors Mutiauk's check (internal/config
// config.go validate): host:port where host is a loopback IP *literal*
// (127.0.0.0/8 or ::1). The admin interface is unauthenticated, so a
// hostname or any non-loopback address is rejected.
export function validateAdminListen(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Listen address is required';

  let host: string;
  let port: string;
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end === -1) return 'IPv6 address must be bracketed, e.g. [::1]:48088';
    host = v.slice(1, end);
    const rest = v.slice(end + 1);
    if (!rest.startsWith(':')) return 'Expected [ipv6]:port';
    port = rest.slice(1);
  } else {
    const idx = v.lastIndexOf(':');
    if (idx === -1) return 'Expected host:port, e.g. 127.0.0.1:48088';
    host = v.slice(0, idx);
    port = v.slice(idx + 1);
  }

  if (!host) return 'Missing host';
  if (!/^\d+$/.test(port)) return 'Port must be numeric';
  const p = Number(port);
  if (p < 1 || p > 65535) return 'Port must be 1-65535';

  const loopbackHint =
    'Admin interface is unauthenticated — bind a loopback address (127.0.0.1 or ::1)';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split('.').map(Number);
    if (octets.some(n => n > 255)) return 'Invalid IPv4 address';
    if (octets[0] !== 127) return loopbackHint;
    return null;
  }
  if (host === '::1') return null;
  return loopbackHint;
}

// Accepts `host:port`, `[ipv6]:port`, or `ws[s]://host[:port]/path` URLs.
export function validateSocks5Server(value: string): string | null {
  const v = value.trim();
  if (!v) return 'SOCKS5 server is required';
  if (/^wss?:\/\//i.test(v)) {
    try {
      const u = new URL(v);
      if (!u.host) return 'WebSocket URL must include a host';
      return null;
    } catch {
      return 'Invalid WebSocket URL';
    }
  }
  return validateHostPort(v);
}
