import { describe, expect, it } from 'vitest';
import { validateAdvertiseAddress } from '../validate';

describe('validateAdvertiseAddress', () => {
  it('accepts a hostname:port', () => {
    expect(validateAdvertiseAddress('kreata.ee:3000')).toBeNull();
    expect(validateAdvertiseAddress('mesh.example.com:4433')).toBeNull();
  });

  it('accepts a public IPv4:port', () => {
    expect(validateAdvertiseAddress('1.2.3.4:443')).toBeNull();
  });

  it('accepts a bracketed public IPv6:port', () => {
    expect(validateAdvertiseAddress('[2001:db8::1]:8080')).toBeNull();
  });

  it('rejects 0.0.0.0 (bind address)', () => {
    expect(validateAdvertiseAddress('0.0.0.0:443')).toMatch(/publicly reachable/);
  });

  it('rejects [::] (bind address)', () => {
    expect(validateAdvertiseAddress('[::]:443')).toMatch(/publicly reachable/);
  });

  it('rejects loopback v4', () => {
    expect(validateAdvertiseAddress('127.0.0.1:8080')).toMatch(/Loopback/);
    expect(validateAdvertiseAddress('127.5.6.7:8080')).toMatch(/Loopback/);
  });

  it('rejects loopback v6', () => {
    expect(validateAdvertiseAddress('[::1]:8080')).toMatch(/Loopback/);
  });

  it('surfaces underlying host:port format errors verbatim', () => {
    expect(validateAdvertiseAddress('')).toBe('Address is required');
    expect(validateAdvertiseAddress('hostnoport')).toBe('Missing :port');
    expect(validateAdvertiseAddress('host:notaport')).toBe('Port must be 1-65535');
  });
});
