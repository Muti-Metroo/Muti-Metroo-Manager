import { useState } from 'react';
import type { FileShare } from '../../api/types';
import { copyToClipboard } from '../../util/clipboard';
import { currentLocation, isLoopbackHost, mountCommands } from '../../util/fileShares';
import Tabs from '../Tabs';

type Os = 'macos' | 'windows' | 'linux';

const OS_TABS: { id: Os; label: string }[] = [
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
];

function defaultOs(): Os {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  return 'linux';
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-xs btn-soft shrink-0"
      onClick={async () => {
        if (await copyToClipboard(text)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }
      }}
      title={`${label} to clipboard`}
    >
      <span
        className={`${copied ? 'icon-[tabler--check]' : 'icon-[tabler--copy]'} size-3.5`}
        aria-hidden="true"
      />
      {copied ? 'Copied' : label}
    </button>
  );
}

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2">
      <code className="bg-base-200 rounded-field min-w-0 flex-1 px-2 py-1 font-mono text-xs break-all">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

interface ShareMountInfoProps {
  share: FileShare;
  // Shown exactly once, right after create or rotate. Null afterwards.
  password?: string | null;
  loopbackOnly: boolean;
}

/**
 * Mount URL, credentials and per-OS mount instructions for one share. The
 * URL host is whatever the browser used to reach Manager, which is the
 * address other machines most likely use too.
 */
export default function ShareMountInfo({ share, password, loopbackOnly }: ShareMountInfoProps) {
  const [os, setOs] = useState<Os>(defaultOs);
  const loc = currentLocation();
  const cmds = mountCommands(loc, share.mount_path, share.username, share.name);
  const plainHttp = loc.protocol !== 'https:';
  const localOnly = loopbackOnly || isLoopbackHost(loc.hostname);

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="font-medium">Mount URL</div>
        <CodeLine text={cmds.url} />
      </div>

      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
        <span className="text-muted">User name</span>
        <div className="flex items-center gap-2">
          <code className="font-mono">{share.username}</code>
          <CopyButton text={share.username} />
        </div>
        {password && (
          <>
            <span className="text-muted">Password</span>
            <div className="flex items-center gap-2">
              <code className="font-mono break-all">{password}</code>
              <CopyButton text={password} />
            </div>
          </>
        )}
      </div>
      {password && (
        <p className="text-warning text-xs" role="note">
          Save this password now. It is shown only once; rotate it from File shares if it is lost.
        </p>
      )}

      {localOnly && (
        <div className="ui-error text-xs" role="note">
          {loopbackOnly
            ? 'Muti Metroo Manager listens on a loopback address, so only clients on the Manager host can mount this share. Restart it with a reachable -addr to mount from other machines.'
            : 'You reached Muti Metroo Manager through a loopback address, so this URL only works on the Manager host. Other machines need the address they use to reach it.'}
        </div>
      )}
      {plainHttp && (
        <div className="ui-hint mb-0" role="note">
          This connection is plain HTTP: the share password and file contents cross the network
          unencrypted. Muti Metroo Manager has no TLS listener of its own, so put it behind a
          TLS-terminating reverse proxy (or reach it over an encrypted tunnel) and mount the
          https:// URL instead.
        </div>
      )}

      <Tabs tabs={OS_TABS} activeId={os} onChange={setOs} size="sm" />
      {os === 'macos' && (
        <div className="space-y-2 text-sm">
          <p>
            In Finder choose <strong>Go &gt; Connect to Server</strong> (Cmd+K), enter the URL
            below, then sign in with the user name and password.
          </p>
          <CodeLine text={cmds.url} />
          <p className="text-muted text-xs">
            Finder mounts the share under /Volumes. A read-only share mounts read-only.
          </p>
        </div>
      )}
      {os === 'windows' && (
        <div className="space-y-2 text-sm">
          <p>
            In a command prompt run the command below (the <code>*</code> prompts for the password),
            or use <strong>Map network drive</strong> in File Explorer with the mount URL.
          </p>
          <CodeLine text={cmds.windows} />
          <ul className="text-muted list-disc space-y-1 ps-5 text-xs">
            <li>
              The <strong>WebClient</strong> service must be running (
              <code>sc start WebClient</code>; set it to Automatic to survive reboots).
            </li>
            {plainHttp && (
              <li>
                Windows refuses Basic authentication over plain HTTP unless{' '}
                <code>BasicAuthLevel</code> is set to <code>2</code> under{' '}
                <code>HKLM\SYSTEM\CurrentControlSet\Services\WebClient\Parameters</code> (then
                restart WebClient). Using HTTPS avoids this.
              </li>
            )}
            <li>
              Windows limits WebDAV downloads to 50 MB by default. Raise{' '}
              <code>FileSizeLimitInBytes</code> in the same registry key (maximum{' '}
              <code>4294967295</code>) for larger files.
            </li>
          </ul>
        </div>
      )}
      {os === 'linux' && (
        <div className="space-y-2 text-sm">
          <p>GNOME Files / gio (enter the password when prompted):</p>
          <CodeLine text={cmds.gio} />
          <p>davfs2 (prompts for user name and password):</p>
          <CodeLine text={cmds.davfs} />
          <p>rclone (replace PASSWORD; the mount point must exist):</p>
          <CodeLine text={cmds.rclone} />
        </div>
      )}
    </div>
  );
}
