import { describe, expect, it } from 'vitest';
import {
  isLoopbackHost,
  isValidShareName,
  mountCommands,
  mountUrl,
  suggestShareName,
} from '../fileShares';

describe('suggestShareName', () => {
  it('slugs the last path segment', () => {
    expect(suggestShareName('/srv/My Files')).toBe('my-files');
    expect(suggestShareName('C:\\Users\\Ann\\Documents\\')).toBe('documents');
    expect(suggestShareName('/data/caf\u00e9__x')).toBe('cafe__x');
  });

  it('falls back to "share" when nothing usable is left', () => {
    expect(suggestShareName('/')).toBe('share');
    expect(suggestShareName('/srv/!!!')).toBe('share');
  });

  it('always produces a valid name', () => {
    for (const p of ['/a', '/srv/-x-', '/' + 'y'.repeat(100), '/srv/Hello World 2']) {
      expect(isValidShareName(suggestShareName(p))).toBe(true);
    }
  });
});

describe('isValidShareName', () => {
  it('matches the server rule', () => {
    expect(isValidShareName('docs')).toBe(true);
    expect(isValidShareName('a_b-1')).toBe(true);
    expect(isValidShareName('Docs')).toBe(false);
    expect(isValidShareName('-docs')).toBe(false);
    expect(isValidShareName('a/b')).toBe(false);
    expect(isValidShareName('')).toBe(false);
    expect(isValidShareName('x'.repeat(65))).toBe(false);
  });
});

describe('mount URLs', () => {
  const http = { protocol: 'http:', hostname: 'manager.lan', port: '3000' };

  it('builds the URL from the browser location', () => {
    expect(mountUrl(http, '/dav/docs/')).toBe('http://manager.lan:3000/dav/docs/');
    // location.hostname keeps the brackets of an IPv6 literal.
    expect(mountUrl({ protocol: 'https:', hostname: '[::1]', port: '' }, '/dav/x/')).toBe(
      'https://[::1]/dav/x/',
    );
    expect(mountUrl({ protocol: 'http:', hostname: '[fe80::1]', port: '3000' }, '/dav/x/')).toBe(
      'http://[fe80::1]:3000/dav/x/',
    );
    // A bare IPv6 address is bracketed.
    expect(mountUrl({ protocol: 'https:', hostname: '::1', port: '' }, '/dav/x/')).toBe(
      'https://[::1]/dav/x/',
    );
  });

  it('renders per-OS commands', () => {
    const c = mountCommands(http, '/dav/docs/', 'alice', 'docs');
    expect(c.windows).toBe('net use Z: http://manager.lan:3000/dav/docs/ /user:alice *');
    expect(c.gio).toBe("gio mount 'dav://alice@manager.lan:3000/dav/docs/'");
    expect(c.davfs).toContain("mount -t davfs 'http://manager.lan:3000/dav/docs/' /mnt/docs");
    expect(c.rclone).toContain("--webdav-url 'http://manager.lan:3000/dav/docs/'");
    const s = mountCommands({ ...http, protocol: 'https:' }, '/dav/docs/', "o'neil", 'docs');
    expect(s.gio.startsWith("gio mount 'davs://")).toBe(true);
    expect(s.rclone).toContain(`--webdav-user 'o'\\''neil'`);
  });

  it('detects loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
    expect(isLoopbackHost('manager.lan')).toBe(false);
  });
});
