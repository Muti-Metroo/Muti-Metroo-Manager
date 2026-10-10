import { describe, expect, it } from 'vitest';
import { EXPOSE_TARGET_PREFIX, isAttachedTarget } from '../types';

describe('isAttachedTarget', () => {
  it('returns true for /api/expose-attached endpoint targets', () => {
    expect(isAttachedTarget('expose:my-key')).toBe(true);
    expect(isAttachedTarget(`${EXPOSE_TARGET_PREFIX}other`)).toBe(true);
  });

  it('returns false for plain TCP host:port targets', () => {
    expect(isAttachedTarget('127.0.0.1:5432')).toBe(false);
    expect(isAttachedTarget('db.internal:80')).toBe(false);
    expect(isAttachedTarget('')).toBe(false);
  });

  it('keeps the prefix string in sync with the agent constant', () => {
    // Mirrors LabelPrefix in Muti Metroo's internal/expose/protocol.go.
    expect(EXPOSE_TARGET_PREFIX).toBe('expose:');
  });
});
