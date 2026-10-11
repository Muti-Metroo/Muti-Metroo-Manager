import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useVisibilityPolling } from '../useVisibilityPolling';

// document.hidden is read-only; flip it via a getter for the duration of
// the test and dispatch visibilitychange like the browser would.
let hidden = false;
function setHidden(value: boolean) {
  hidden = value;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('useVisibilityPolling', () => {
  beforeEach(() => {
    hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (document as { hidden?: boolean }).hidden;
  });

  it('runs immediately and then on the interval while visible', () => {
    const callback = vi.fn();
    renderHook(() => useVisibilityPolling(callback, 1000));

    expect(callback).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('stops the interval while hidden and refreshes immediately on return', () => {
    const callback = vi.fn();
    renderHook(() => useVisibilityPolling(callback, 1000));
    expect(callback).toHaveBeenCalledTimes(1);

    setHidden(true);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);

    setHidden(false);
    expect(callback).toHaveBeenCalledTimes(2);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('does not start the interval when mounted hidden', () => {
    hidden = true;
    const callback = vi.fn();
    renderHook(() => useVisibilityPolling(callback, 1000));

    // One initial fetch so a background-loaded tab still has data.
    expect(callback).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('cleans up the interval and listener on unmount', () => {
    const callback = vi.fn();
    const { unmount } = renderHook(() => useVisibilityPolling(callback, 1000));
    unmount();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    setHidden(true);
    setHidden(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
