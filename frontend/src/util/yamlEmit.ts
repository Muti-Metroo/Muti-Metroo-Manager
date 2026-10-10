export type YamlValue = string | number | boolean | null | { [k: string]: YamlValue } | YamlValue[];

const BARE_KEY = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function needsQuoting(s: string): boolean {
  if (s === '') return true;
  if (/^\s|\s$/.test(s)) return true;
  // First-char indicators that would confuse a plain-scalar parser.
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true;
  // Mapping-value delimiter: only `: ` or trailing `:` disambiguates a value.
  if (/: /.test(s) || /:$/.test(s)) return true;
  if (/ #/.test(s)) return true;
  if (/[\r\n\t]/.test(s)) return true;
  if (/["'\\]/.test(s)) return true;
  const lower = s.toLowerCase();
  if (['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~'].includes(lower)) return true;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return true;
  return false;
}

function quote(s: string): string {
  const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function formatScalar(value: Exclude<YamlValue, object | unknown[]>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return needsQuoting(value) ? quote(value) : value;
}

function formatKey(key: string): string {
  return BARE_KEY.test(key) ? key : quote(key);
}

function emitBlockScalar(indent: string, value: string): string[] {
  // Strip trailing newlines so the default clip indicator yields exactly one.
  const content = value.replace(/\r\n/g, '\n').replace(/\n+$/, '');
  const lines = content.split('\n');
  const childIndent = indent + '  ';
  return ['|', ...lines.map(l => (l === '' ? '' : childIndent + l))];
}

function emitValue(value: YamlValue, indent: string): string[] {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.includes('\n')) {
      return emitBlockScalar(indent, value);
    }
    return [formatScalar(value)];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return ['[]'];
    const out: string[] = [''];
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const rendered = emitObject(item as Record<string, YamlValue>, indent + '  ');
        if (rendered.length === 0) {
          out.push(`${indent}- {}`);
        } else {
          out.push(`${indent}- ${rendered[0].slice((indent + '  ').length)}`);
          for (let i = 1; i < rendered.length; i++) out.push(rendered[i]);
        }
      } else {
        const inline = emitValue(item, indent);
        out.push(`${indent}- ${inline[0]}`);
        for (let i = 1; i < inline.length; i++) out.push(indent + '  ' + inline[i]);
      }
    }
    return out;
  }
  const rendered = emitObject(value as Record<string, YamlValue>, indent);
  if (rendered.length === 0) return ['{}'];
  return ['', ...rendered];
}

export function emitObject(obj: Record<string, YamlValue>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (raw === undefined) continue;
    const k = formatKey(key);
    if (raw === null || typeof raw !== 'object') {
      if (typeof raw === 'string' && raw.includes('\n')) {
        const block = emitBlockScalar(indent, raw);
        lines.push(`${indent}${k}: ${block[0]}`);
        for (let i = 1; i < block.length; i++) lines.push(block[i]);
      } else {
        lines.push(`${indent}${k}: ${formatScalar(raw)}`);
      }
      continue;
    }
    if (Array.isArray(raw)) {
      // Skip empty arrays to match yaml `,omitempty` semantics.
      if (raw.length === 0) continue;
      lines.push(`${indent}${k}:`);
      for (const item of raw) {
        if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const child = emitObject(item as Record<string, YamlValue>, indent + '    ');
          if (child.length === 0) {
            lines.push(`${indent}  - {}`);
            continue;
          }
          lines.push(`${indent}  - ${child[0].slice((indent + '    ').length)}`);
          for (let i = 1; i < child.length; i++) lines.push(child[i]);
        } else {
          const inner = emitValue(item, indent + '  ');
          lines.push(`${indent}  - ${inner[0]}`);
          for (let i = 1; i < inner.length; i++) lines.push(indent + '    ' + inner[i]);
        }
      }
      continue;
    }
    const child = emitObject(raw as Record<string, YamlValue>, indent + '  ');
    if (child.length === 0) continue;
    lines.push(`${indent}${k}:`);
    for (const c of child) lines.push(c);
  }
  return lines;
}

export function prune(value: YamlValue): YamlValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'boolean') return value === false ? undefined : value;
  if (typeof value === 'number') return value === 0 ? undefined : value;
  if (Array.isArray(value)) {
    const pruned = value.map(v => prune(v)).filter(v => v !== undefined) as YamlValue[];
    return pruned.length ? pruned : undefined;
  }
  const out: Record<string, YamlValue> = {};
  let any = false;
  for (const [k, v] of Object.entries(value as Record<string, YamlValue>)) {
    const p = prune(v);
    if (p !== undefined) {
      out[k] = p;
      any = true;
    }
  }
  return any ? out : undefined;
}
