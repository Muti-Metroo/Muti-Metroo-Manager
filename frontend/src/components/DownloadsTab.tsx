import { useMemo, useState } from 'react';
import type { DownloadsManifest, DownloadsManifestFile } from '../api/types';
import { downloadsFileURL } from '../api/client';

interface DownloadsTabProps {
  manifest: DownloadsManifest;
  // Called when the user clicks "Create config" inside a section that
  // has a wizard. Only invoked for categories where configurable=true
  // in BINARY_GROUPS below.
  onCreateConfig: (category: DownloadsManifestFile['category']) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// Once an arch is picked the user has already chosen "what kind of CPU
// am I downloading for?", so the row label can be the OS instead of the
// archive filename. Filenames stay an internal detail.
type ArchTab = 'amd64' | 'arm64';

const ARCH_TABS: { id: ArchTab; label: string; subtitle: string }[] = [
  { id: 'amd64', label: 'amd64 (x86_64)', subtitle: 'Intel / AMD 64-bit machines.' },
  {
    id: 'arm64',
    label: 'arm64 (aarch64)',
    subtitle: 'Apple Silicon, Raspberry Pi 4+, Graviton, etc.',
  },
];

interface BinaryGroup {
  id: DownloadsManifestFile['category'];
  title: string;
  subtitle: string;
  // True when this section should expose a "Create config" button that
  // opens the matching wizard. DLL has no separate wizard.
  configurable?: boolean;
}

const BINARY_GROUPS: BinaryGroup[] = [
  {
    id: 'agent',
    title: 'Muti Metroo Agent',
    subtitle: 'Run a Muti Metroo node on your machine.',
    configurable: true,
  },
  {
    id: 'agent-dll',
    title: 'Muti Metroo Agent DLL',
    subtitle: 'Embeddable Windows library variant.',
  },
  {
    id: 'entry',
    title: 'Mutiauk',
    subtitle: 'Linux ingress agent with TUN support.',
    configurable: true,
  },
];

function formatGenerated(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function downloadLabel(f: DownloadsManifestFile): string {
  return f.download_name || f.name;
}

// Friendly titles for the well-known documentation artifacts shipped in
// the bundle. Falls back to the download filename if a doc shows up that
// we don't recognise — keeps unknown future docs from breaking.
const DOC_TITLES: Record<string, string> = {
  'user-manual.pdf': 'User Manual',
  'operator-manual.pdf': 'Operator Manual',
  'operator-slides.pdf': 'Operator Slides',
};

function docTitle(f: DownloadsManifestFile): string {
  return DOC_TITLES[downloadLabel(f)] ?? downloadLabel(f);
}

function PlatformRow({ f }: { f: DownloadsManifestFile }) {
  return (
    <tr>
      <td>
        <span className="block font-medium">{f.os || '-'}</span>
        {f.sha256 && (
          <code className="text-muted block truncate font-mono text-[0.6875rem]" title="SHA256">
            {f.sha256}
          </code>
        )}
      </td>
      <td className="text-end font-mono">{formatSize(f.size)}</td>
      <td className="text-end">
        <a
          className="btn btn-xs btn-soft btn-primary"
          href={downloadsFileURL(f.name)}
          download={downloadLabel(f)}
        >
          Download
        </a>
      </td>
    </tr>
  );
}

const TABLE_COLGROUP = (
  <colgroup>
    <col />
    <col className="w-24" />
    <col className="w-32" />
  </colgroup>
);

type Category = DownloadsManifestFile['category'];

export default function DownloadsTab({ manifest, onCreateConfig }: DownloadsTabProps) {
  // Each binary section keeps its own arch selection — toggling one
  // section doesn't change the others.
  const [archByCategory, setArchByCategory] = useState<Partial<Record<Category, ArchTab>>>({});

  const setSectionArch = (cat: Category, a: ArchTab) =>
    setArchByCategory(prev => ({ ...prev, [cat]: a }));

  // Documentation isn't arch-specific, so it lives outside the tab strip.
  const docs = useMemo(() => manifest.files.filter(f => f.category === 'manual'), [manifest.files]);

  // category → arch → file list, indexed once so renders are cheap.
  const filesByCategoryArch = useMemo(() => {
    const out = new Map<Category, Map<string, DownloadsManifestFile[]>>();
    for (const f of manifest.files) {
      if (f.category === 'manual') continue;
      if (!out.has(f.category)) out.set(f.category, new Map());
      const byArch = out.get(f.category)!;
      if (!byArch.has(f.arch)) byArch.set(f.arch, []);
      byArch.get(f.arch)!.push(f);
    }
    const osOrder = ['Linux', 'macOS', 'Windows'];
    for (const byArch of out.values()) {
      for (const list of byArch.values()) {
        list.sort((a, b) => osOrder.indexOf(a.os) - osOrder.indexOf(b.os));
      }
    }
    return out;
  }, [manifest.files]);

  // Categories that ship at least one build (any arch). Used to skip
  // sections that aren't in this bundle at all.
  const presentCategories = useMemo(
    () => new Set(filesByCategoryArch.keys()),
    [filesByCategoryArch],
  );

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {manifest.muti_metroo_version && (
            <span className="badge badge-sm badge-soft badge-primary font-mono">
              Muti Metroo {manifest.muti_metroo_version}
            </span>
          )}
          {manifest.entry_version && (
            <span className="badge badge-sm badge-soft badge-primary font-mono">
              Mutiauk {manifest.entry_version}
            </span>
          )}
        </div>
        {manifest.generated_at && (
          <div className="text-muted ms-auto text-xs">
            Bundled {formatGenerated(manifest.generated_at)}
          </div>
        )}
      </div>

      {docs.length > 0 && (
        <section className="ui-section overflow-hidden">
          <header className="border-hairline border-b px-3 py-2">
            <h3 className="font-semibold">Documentation</h3>
            <p className="text-muted text-xs">User manual and reference material.</p>
          </header>
          <div className="overflow-x-auto">
            <table className="table table-sm">
              {TABLE_COLGROUP}
              <tbody>
                {docs.map(f => (
                  <tr key={f.name}>
                    <td>
                      <span className="block font-medium">{docTitle(f)}</span>
                      <code
                        className="text-muted block truncate font-mono text-[0.6875rem]"
                        title={`Saves as ${downloadLabel(f)}`}
                      >
                        {downloadLabel(f)}
                      </code>
                    </td>
                    <td className="text-end font-mono">{formatSize(f.size)}</td>
                    <td className="text-end">
                      <a
                        className="btn btn-xs btn-soft btn-primary"
                        href={downloadsFileURL(f.name)}
                        download={downloadLabel(f)}
                      >
                        Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {BINARY_GROUPS.map(group => {
        if (!presentCategories.has(group.id)) return null;
        const byArch = filesByCategoryArch.get(group.id)!;
        const sectionArches = byArch;
        // Pick a sensible default for this section: amd64 if available,
        // otherwise whichever arch we do have. The user's per-section
        // override lives in archByCategory.
        const fallbackArch: ArchTab = sectionArches.has('amd64')
          ? 'amd64'
          : sectionArches.has('arm64')
            ? 'arm64'
            : 'amd64';
        const sectionArch = archByCategory[group.id] ?? fallbackArch;
        const files = byArch.get(sectionArch) ?? [];
        return (
          <section key={group.id} className="ui-section overflow-hidden">
            <header className="border-hairline flex flex-wrap items-center gap-2 border-b px-3 py-2">
              <div className="min-w-0 flex-1">
                <h3 className="font-semibold">{group.title}</h3>
                <p className="text-muted text-xs">{group.subtitle}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {group.configurable && (
                  <button
                    type="button"
                    className="btn btn-xs btn-soft"
                    onClick={() => onCreateConfig(group.id)}
                  >
                    Create config
                  </button>
                )}
                <div className="flex gap-1" role="tablist">
                  {ARCH_TABS.map(t => {
                    const enabled = sectionArches.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="tab"
                        aria-selected={sectionArch === t.id}
                        disabled={!enabled}
                        title={enabled ? '' : `No ${t.id} build for ${group.title}`}
                        className={`btn btn-xs ${sectionArch === t.id ? 'btn-primary' : 'btn-text'}`}
                        onClick={() => enabled && setSectionArch(group.id, t.id)}
                      >
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </header>
            <div className="overflow-x-auto">
              <table className="table table-sm">
                {TABLE_COLGROUP}
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th className="text-end">Size</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {files.map(f => (
                    <PlatformRow key={f.name} f={f} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
