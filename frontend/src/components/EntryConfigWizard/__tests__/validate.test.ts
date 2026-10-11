import { describe, expect, it } from 'vitest';
import { validateIPv4CIDR, validateSocks5Server, validateAdminListen } from '../validate';

describe('validateIPv4CIDR', () => {
  it('accepts valid v4', () => expect(validateIPv4CIDR('10.0.0.0/8')).toBeNull());
  it('rejects v6', () => expect(validateIPv4CIDR('::1/128')).toMatch(/IPv4/));
  it('rejects out-of-range octets', () =>
    expect(validateIPv4CIDR('300.0.0.0/8')).toMatch(/octets/));
});

describe('validateSocks5Server', () => {
  it('accepts host:port', () => expect(validateSocks5Server('127.0.0.1:1080')).toBeNull());
  it('accepts wss URL', () =>
    expect(validateSocks5Server('wss://relay.example.com/socks5')).toBeNull());
  it('rejects missing port', () => expect(validateSocks5Server('host')).toBeTruthy());
  it('rejects bare wss:// scheme', () => expect(validateSocks5Server('wss://')).toBeTruthy());
});

describe('validateAdminListen', () => {
  it('accepts the loopback IPv4 default', () =>
    expect(validateAdminListen('127.0.0.1:48088')).toBeNull());
  it('accepts other 127.0.0.0/8 addresses', () =>
    expect(validateAdminListen('127.0.0.5:9090')).toBeNull());
  it('accepts bracketed IPv6 loopback', () =>
    expect(validateAdminListen('[::1]:48088')).toBeNull());
  it('rejects 0.0.0.0', () => expect(validateAdminListen('0.0.0.0:48088')).toMatch(/loopback/));
  it('rejects a routable IP', () =>
    expect(validateAdminListen('192.168.1.10:48088')).toMatch(/loopback/));
  it('rejects a hostname', () =>
    expect(validateAdminListen('localhost:48088')).toMatch(/loopback/));
  it('rejects a missing port', () => expect(validateAdminListen('127.0.0.1')).toBeTruthy());
  it('rejects an empty value', () => expect(validateAdminListen('')).toBeTruthy());
});
