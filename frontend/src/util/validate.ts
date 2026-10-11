import nacl from 'tweetnacl';

// Mirrors the agent-side isAdvertisableHost rule: bind addresses
// (0.0.0.0, ::) and loopbacks (127.x, ::1) are rejected because they
// can't be a useful dial target for any other agent. Hostnames pass
// through — we trust DNS to point at a real address.
export function validateAdvertiseAddress(value: string): string | null {
  const baseError = validateHostPort(value);
  if (baseError) return baseError;
  const v = value.trim();
  let host: string;
  if (v.startsWith('[')) {
    host = v.slice(1, v.indexOf(']'));
  } else {
    host = v.slice(0, v.lastIndexOf(':'));
  }
  const lowered = host.toLowerCase();
  if (lowered === '0.0.0.0' || lowered === '::') {
    return 'Use a publicly reachable host, not the bind address';
  }
  if (lowered === '127.0.0.1' || lowered === '::1' || lowered.startsWith('127.')) {
    return 'Loopback addresses are not reachable from other agents';
  }
  return null;
}

export function validateHostPort(
  value: string,
  opts?: { allowEmptyHost?: boolean },
): string | null {
  const v = value.trim();
  if (!v) return 'Address is required';

  let host: string;
  let port: string;

  if (v.startsWith('[')) {
    const close = v.indexOf(']');
    if (close === -1) return 'Unclosed IPv6 bracket';
    host = v.slice(1, close);
    if (v[close + 1] !== ':') return 'Missing :port after IPv6 address';
    port = v.slice(close + 2);
  } else {
    const idx = v.lastIndexOf(':');
    if (idx === -1) return 'Missing :port';
    host = v.slice(0, idx);
    port = v.slice(idx + 1);
  }

  if (!host && !opts?.allowEmptyHost) return 'Missing host';
  const p = Number(port);
  if (!/^\d+$/.test(port) || !Number.isInteger(p) || p < 1 || p > 65535) {
    return 'Port must be 1-65535';
  }
  return null;
}

export function validateCIDR(value: string): string | null {
  const v = value.trim();
  if (!v) return 'CIDR is required';
  const slash = v.indexOf('/');
  if (slash === -1) return 'CIDR must include /prefix';
  const addr = v.slice(0, slash);
  const mask = v.slice(slash + 1);
  if (!/^\d+$/.test(mask)) return 'Prefix must be numeric';
  const maskN = Number(mask);
  const isIPv6 = addr.includes(':');
  if (isIPv6) {
    if (!/^[0-9a-fA-F:]+$/.test(addr)) return 'Invalid IPv6 address';
    if (maskN < 0 || maskN > 128) return 'IPv6 prefix must be 0-128';
  } else {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return 'Invalid IPv4 address';
    const parts = addr.split('.').map(Number);
    if (parts.some(n => n < 0 || n > 255)) return 'IPv4 octets must be 0-255';
    if (maskN < 0 || maskN > 32) return 'IPv4 prefix must be 0-32';
  }
  return null;
}

export function validatePem(value: string, kind?: string): string | null {
  const v = value.trim();
  if (!v) return 'PEM content is required';
  const marker = kind ? new RegExp(`-----BEGIN ${kind}-----`) : /-----BEGIN [A-Z0-9 ]+-----/;
  const endMarker = kind ? new RegExp(`-----END ${kind}-----`) : /-----END [A-Z0-9 ]+-----/;
  if (!marker.test(v)) return 'Missing BEGIN marker';
  if (!endMarker.test(v)) return 'Missing END marker';
  return null;
}

export function validateHexKey(value: string, expectedChars: number): string | null {
  const v = value.trim();
  if (!v) return 'Hex key is required';
  if (v.length !== expectedChars)
    return `Expected ${expectedChars} hex characters, got ${v.length}`;
  if (!/^[0-9a-fA-F]+$/.test(v)) return 'Must contain only hex characters';
  return null;
}

export function validatePath(value: string): string | null {
  const v = value.trim();
  if (!v) return 'Path is required';
  if (!v.startsWith('/')) return 'Path must start with /';
  return null;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

// Returns null when either side is malformed (validateHexKey surfaces
// the format error at the call site) or when the pair matches; the
// supplied mismatchMsg otherwise.
function validateKeyPair(
  privateHex: string,
  publicHex: string,
  privLen: number,
  derivePublic: (priv: string) => string,
  mismatchMsg: string,
): string | null {
  const priv = privateHex.trim().toLowerCase();
  const pub = publicHex.trim().toLowerCase();
  if (priv.length !== privLen || !/^[0-9a-f]+$/.test(priv)) return null;
  if (pub.length !== 64 || !/^[0-9a-f]+$/.test(pub)) return null;
  if (derivePublic(priv) !== pub) return mismatchMsg;
  return null;
}

/** Verify an X25519 32-byte private (64 hex) matches the given public. */
export function validateX25519KeyPair(privateHex: string, publicHex: string): string | null {
  return validateKeyPair(
    privateHex,
    publicHex,
    64,
    p => bytesToHex(nacl.scalarMult.base(hexToBytes(p))),
    'Private key does not match the configured public key',
  );
}

/** Verify an Ed25519 64-byte private (128 hex) matches the given public.
 *  Go's crypto/ed25519 lays the private key out as `seed || public`, so
 *  bytes 32..64 (chars 64..128 of the hex) already are the public key. */
export function validateEd25519KeyPair(privateHex: string, publicHex: string): string | null {
  return validateKeyPair(
    privateHex,
    publicHex,
    128,
    p => p.slice(64),
    'Signing private key does not match the configured signing public key',
  );
}
