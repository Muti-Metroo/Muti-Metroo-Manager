// Helpers for the WebDAV file-share UI: share-name slugs, mount URLs and
// the per-OS mount commands shown after a share is created.

const SHARE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isValidShareName(name: string): boolean {
  return SHARE_NAME_RE.test(name);
}

/** Suggest a share name from a remote folder path ("/srv/My Files" -> "my-files"). */
export function suggestShareName(remotePath: string): string {
  const base =
    remotePath
      .split(/[\\/]+/)
      .filter(Boolean)
      .pop() ?? '';
  const slug = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return slug || 'share';
}

export interface MountLocation {
  protocol: string; // 'http:' | 'https:'
  hostname: string; // as in location.hostname (an IPv6 literal keeps its brackets: '[::1]')
  port: string; // '' for the scheme default
}

/** The browser's own location, which is where a share is mounted from. */
export function currentLocation(): MountLocation {
  return {
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    port: window.location.port,
  };
}

function hostPart(loc: MountLocation): string {
  const h = loc.hostname;
  const host = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  return loc.port ? `${host}:${loc.port}` : host;
}

/** The URL a WebDAV client mounts, e.g. http://manager:3000/dav/docs/. */
export function mountUrl(loc: MountLocation, mountPath: string): string {
  return `${loc.protocol}//${hostPart(loc)}${mountPath}`;
}

/** True when the browser reached Manager through a loopback name or address. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

export interface MountCommands {
  url: string;
  windows: string;
  gio: string;
  davfs: string;
  rclone: string;
}

// POSIX single-quote escaping for the shell snippets.
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

export function mountCommands(
  loc: MountLocation,
  mountPath: string,
  username: string,
  name: string,
): MountCommands {
  const url = mountUrl(loc, mountPath);
  const davScheme = loc.protocol === 'https:' ? 'davs' : 'dav';
  const gioUrl = `${davScheme}://${encodeURIComponent(username)}@${hostPart(loc)}${mountPath}`;
  const winUser = /[\s"]/.test(username) ? `"${username.replace(/"/g, '')}"` : username;
  return {
    url,
    windows: `net use Z: ${url} /user:${winUser} *`,
    gio: `gio mount ${sq(gioUrl)}`,
    davfs: `sudo mkdir -p /mnt/${name} && sudo mount -t davfs ${sq(url)} /mnt/${name}`,
    rclone: `rclone mount :webdav: ~/${name} --webdav-url ${sq(url)} --webdav-user ${sq(username)} --webdav-pass "$(rclone obscure 'PASSWORD')" --vfs-cache-mode writes`,
  };
}
