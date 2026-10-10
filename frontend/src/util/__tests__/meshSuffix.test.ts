import { describe, expect, it } from 'vitest';
import { matchSuffix, normalizeSuffix } from '../meshSuffix';

describe('matchSuffix', () => {
  it('matches a single-label suffix', () => {
    expect(matchSuffix('target-11.mesh', ['mesh'])).toBe('mesh');
  });

  it('matches a multi-level suffix', () => {
    expect(matchSuffix('foo.muti-metroo.alt', ['muti-metroo.alt'])).toBe('muti-metroo.alt');
  });

  it('prefers the longest matching suffix', () => {
    // Both `alt` and `muti-metroo.alt` are configured; `foo.muti-metroo.alt` must
    // match the longer one so the user does not "leak" out of muti-metroo.alt
    // into a shorter parent TLD.
    expect(matchSuffix('foo.muti-metroo.alt', ['alt', 'muti-metroo.alt'])).toBe('muti-metroo.alt');
  });

  it('returns null when no suffix matches', () => {
    expect(matchSuffix('host.lan', ['mesh', 'alt'])).toBeNull();
  });

  it('rejects single-label names even when they equal a suffix', () => {
    // `mesh` alone is one label — invalid as a mesh-host name. The
    // agent's hosts store rejects this server-side too.
    expect(matchSuffix('mesh', ['mesh'])).toBeNull();
    expect(matchSuffix('alt', ['alt', 'muti-metroo.alt'])).toBeNull();
  });

  it('matches a multi-level bare-TLD name (still has ≥2 labels)', () => {
    expect(matchSuffix('muti-metroo.alt', ['alt', 'muti-metroo.alt'])).toBe('muti-metroo.alt');
  });

  it('still rejects names that look like a suffix with a stray leading dot', () => {
    expect(matchSuffix('.mesh', ['mesh'])).toBeNull();
  });

  it('returns null on empty suffix list', () => {
    expect(matchSuffix('foo.mesh', [])).toBeNull();
  });
});

describe('normalizeSuffix', () => {
  it('accepts a single label', () => {
    expect(normalizeSuffix('mesh')).toEqual({ ok: true, value: 'mesh' });
  });

  it('accepts a multi-level suffix', () => {
    expect(normalizeSuffix('muti-metroo.alt')).toEqual({ ok: true, value: 'muti-metroo.alt' });
    expect(normalizeSuffix('lab.test.mesh')).toEqual({ ok: true, value: 'lab.test.mesh' });
  });

  it('lowercases and trims', () => {
    expect(normalizeSuffix('  Muti-Metroo.ALT  ')).toEqual({ ok: true, value: 'muti-metroo.alt' });
  });

  it('rejects empty input', () => {
    const r = normalizeSuffix('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/required/i);
  });

  it('rejects leading dot', () => {
    const r = normalizeSuffix('.mesh');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/start with a dot/);
  });

  it('rejects trailing dot', () => {
    const r = normalizeSuffix('mesh.');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/end with a dot/);
  });

  it('rejects empty middle label (consecutive dots)', () => {
    const r = normalizeSuffix('muti-metroo..alt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not a valid DNS label/);
  });

  it('rejects labels with invalid characters', () => {
    expect(normalizeSuffix('me_sh').ok).toBe(false);
    expect(normalizeSuffix('mesh!').ok).toBe(false);
    expect(normalizeSuffix('-mesh').ok).toBe(false);
    expect(normalizeSuffix('mesh-').ok).toBe(false);
  });

  it('accepts hyphens inside labels', () => {
    expect(normalizeSuffix('my-mesh.alt')).toEqual({ ok: true, value: 'my-mesh.alt' });
  });
});
