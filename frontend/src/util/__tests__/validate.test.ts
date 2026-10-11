import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import {
  validateCIDR,
  validateEd25519KeyPair,
  validateHexKey,
  validateHostPort,
  validatePath,
  validatePem,
  validateX25519KeyPair,
} from '../validate';

function bytesHex(b: Uint8Array): string {
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

describe('validateHostPort', () => {
  it('accepts host:port', () => {
    expect(validateHostPort('example.com:4433')).toBeNull();
    expect(validateHostPort('0.0.0.0:4433')).toBeNull();
  });
  it('accepts IPv6 in brackets', () => {
    expect(validateHostPort('[::1]:8080')).toBeNull();
  });
  it('rejects missing port', () => {
    expect(validateHostPort('example.com')).toMatch(/Missing :port/);
  });
  it('rejects out-of-range ports', () => {
    expect(validateHostPort('x:0')).toMatch(/Port must be/);
    expect(validateHostPort('x:70000')).toMatch(/Port must be/);
  });
  it('allowEmptyHost permits :8080 style', () => {
    expect(validateHostPort(':8080', { allowEmptyHost: true })).toBeNull();
    expect(validateHostPort(':8080')).toMatch(/Missing host/);
  });
});

describe('validateCIDR', () => {
  it('accepts v4', () => {
    expect(validateCIDR('10.0.0.0/8')).toBeNull();
    expect(validateCIDR('192.168.1.0/24')).toBeNull();
  });
  it('accepts v6', () => {
    expect(validateCIDR('fd00::/8')).toBeNull();
  });
  it('rejects missing slash', () => {
    expect(validateCIDR('10.0.0.0')).toMatch(/CIDR must include/);
  });
  it('rejects bad mask', () => {
    expect(validateCIDR('10.0.0.0/99')).toMatch(/IPv4 prefix/);
    expect(validateCIDR('fd00::/200')).toMatch(/IPv6 prefix/);
  });
  it('rejects bad octets', () => {
    expect(validateCIDR('300.0.0.0/8')).toMatch(/octets/);
  });
});

describe('validatePem', () => {
  it('accepts a block with matching markers', () => {
    expect(
      validatePem('-----BEGIN CERTIFICATE-----\nAAA=\n-----END CERTIFICATE-----', 'CERTIFICATE'),
    ).toBeNull();
  });
  it('rejects missing markers', () => {
    expect(validatePem('AAA=')).toMatch(/BEGIN/);
  });
  it('rejects missing end', () => {
    expect(validatePem('-----BEGIN CERTIFICATE-----\nAAA=')).toMatch(/END/);
  });
});

describe('validateHexKey', () => {
  it('accepts right length of hex', () => {
    expect(validateHexKey('a'.repeat(64), 64)).toBeNull();
    expect(validateHexKey('DEAD'.repeat(16), 64)).toBeNull();
  });
  it('rejects non-hex', () => {
    expect(validateHexKey('z'.repeat(64), 64)).toMatch(/hex characters/);
  });
  it('rejects wrong length', () => {
    expect(validateHexKey('ab', 64)).toMatch(/Expected 64/);
  });
});

describe('validatePath', () => {
  it('requires leading slash', () => {
    expect(validatePath('/mesh')).toBeNull();
    expect(validatePath('mesh')).toMatch(/start with/);
  });
});

describe('validateX25519KeyPair', () => {
  it('accepts a matching pair', () => {
    const seed = new Uint8Array(32).fill(7);
    const pub = nacl.scalarMult.base(seed);
    expect(validateX25519KeyPair(bytesHex(seed), bytesHex(pub))).toBeNull();
  });
  it('rejects a mismatched pair', () => {
    const seed = new Uint8Array(32).fill(7);
    const wrongPub = bytesHex(new Uint8Array(32).fill(1));
    expect(validateX25519KeyPair(bytesHex(seed), wrongPub)).toMatch(/does not match/);
  });
  it('returns null on malformed input (other validators surface that)', () => {
    expect(validateX25519KeyPair('zz', 'zz')).toBeNull();
    expect(validateX25519KeyPair('aa'.repeat(32), '')).toBeNull();
  });
  it('case-insensitive on hex', () => {
    const seed = new Uint8Array(32).fill(7);
    const pub = nacl.scalarMult.base(seed);
    expect(
      validateX25519KeyPair(bytesHex(seed).toUpperCase(), bytesHex(pub).toUpperCase()),
    ).toBeNull();
  });
});

describe('validateEd25519KeyPair', () => {
  it('accepts a matching pair (libsodium seed||public layout)', () => {
    const kp = nacl.sign.keyPair();
    // tweetnacl's secretKey is already 64 bytes = seed||public, matching
    // Go's crypto/ed25519 layout.
    expect(validateEd25519KeyPair(bytesHex(kp.secretKey), bytesHex(kp.publicKey))).toBeNull();
  });
  it('rejects a mismatched pair', () => {
    const kp = nacl.sign.keyPair();
    const wrongPub = bytesHex(new Uint8Array(32).fill(2));
    expect(validateEd25519KeyPair(bytesHex(kp.secretKey), wrongPub)).toMatch(/does not match/);
  });
  it('returns null on malformed input', () => {
    expect(validateEd25519KeyPair('aa', 'aa')).toBeNull();
  });
});
