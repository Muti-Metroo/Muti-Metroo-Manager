import { describe, it, expect } from 'vitest';
import {
  knownNetworks,
  normalizeNetworks,
  parseNetworks,
  replaceTokenAtCaret,
  tokenAtCaret,
} from '../networks';
import type { AgentMetadataMap } from '../../api/types';

const meta = (networks: Record<string, string>): AgentMetadataMap =>
  Object.fromEntries(
    Object.entries(networks).map(([id, nets]) => [id, { note: '', icon: '', networks: nets }]),
  );

describe('normalizeNetworks', () => {
  it('strips illegal characters, drops empties and de-duplicates', () => {
    expect(normalizeNetworks('prod, edge 1,,prod')).toBe('prod,edge1');
  });
});

describe('parseNetworks', () => {
  it('splits a stored list and tolerates stray separators', () => {
    expect(parseNetworks('a,b')).toEqual(['a', 'b']);
    expect(parseNetworks('')).toEqual([]);
    expect(parseNetworks('a,,b')).toEqual(['a', 'b']);
  });
});

describe('knownNetworks', () => {
  it('unions membership across agents and sorts by id', () => {
    const nets = knownNetworks(meta({ a: 'pubnet,ovh', b: 'zone,pubnet' }), {});
    expect(nets.map(n => n.id)).toEqual(['ovh', 'pubnet', 'zone']);
    expect(nets.every(n => n.title === '')).toBe(true);
  });

  it('carries the operator-set title', () => {
    const nets = knownNetworks(meta({ a: 'pubnet' }), { pubnet: 'PUBNET 10.8.0.0/24' });
    expect(nets).toEqual([{ id: 'pubnet', title: 'PUBNET 10.8.0.0/24' }]);
  });

  // A name that collides with something on Object.prototype must not read a
  // function off the prototype chain.
  it('ignores inherited properties when looking up a title', () => {
    const nets = knownNetworks(meta({ a: 'constructor,toString' }), {});
    expect(nets).toEqual([
      { id: 'constructor', title: '' },
      { id: 'toString', title: '' },
    ]);
  });

  // A network can exist purely because it was renamed, e.g. its last member
  // was just removed, and should still be offered.
  it('includes a titled network with no members', () => {
    expect(knownNetworks(meta({ a: '' }), { orphan: 'Orphan' })).toEqual([
      { id: 'orphan', title: 'Orphan' },
    ]);
  });
});

describe('tokenAtCaret', () => {
  // The whole token, not just the part before the caret: editing the middle
  // of "edge" should still filter suggestions on "edge".
  it('returns the token the caret sits inside, not the whole field', () => {
    expect(tokenAtCaret('prod,edge', 7)).toEqual({ text: 'edge', start: 5, end: 9 });
  });

  it('handles the first token and a caret at either boundary', () => {
    expect(tokenAtCaret('prod,edge', 0)).toEqual({ text: 'prod', start: 0, end: 4 });
    expect(tokenAtCaret('prod,edge', 4)).toEqual({ text: 'prod', start: 0, end: 4 });
    expect(tokenAtCaret('prod,edge', 5)).toEqual({ text: 'edge', start: 5, end: 9 });
  });

  it('returns an empty token right after a separator', () => {
    expect(tokenAtCaret('prod,', 5)).toEqual({ text: '', start: 5, end: 5 });
  });

  it('trims surrounding spaces so a typed "a, b" still matches', () => {
    expect(tokenAtCaret('prod, ed', 8).text).toBe('ed');
  });

  it('clamps a caret outside the string', () => {
    expect(tokenAtCaret('prod', 99).text).toBe('prod');
    expect(tokenAtCaret('prod', -5).text).toBe('prod');
  });
});

describe('replaceTokenAtCaret', () => {
  it('swaps only the token under the caret and reports the new caret', () => {
    expect(replaceTokenAtCaret('prod,ed', 7, 'edge-1')).toEqual({
      value: 'prod,edge-1',
      caret: 11,
    });
  });

  it('replaces the whole token when the caret is mid-word', () => {
    expect(replaceTokenAtCaret('prod,edg', 7, 'edge-1')).toEqual({
      value: 'prod,edge-1',
      caret: 11,
    });
  });

  it('fills an empty trailing token', () => {
    expect(replaceTokenAtCaret('prod,', 5, 'zone')).toEqual({ value: 'prod,zone', caret: 9 });
  });

  it('leaves following tokens intact', () => {
    expect(replaceTokenAtCaret('pr,zone', 2, 'prod')).toEqual({ value: 'prod,zone', caret: 4 });
  });
});
