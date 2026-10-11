import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useAgentResource } from '../useAgentResource';
import { ApiError } from '../../api/client';

describe('useAgentResource', () => {
  it('fetches on mount and exposes the data once resolved', async () => {
    const fetcher = vi.fn().mockResolvedValue(['a', 'b']);
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'nope' }, []),
    );
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(['a', 'b']);
    expect(result.current.error).toBeNull();
    expect(result.current.unavailable).toBe(false);
  });

  it('maps a 502 ApiError to the unavailable state', async () => {
    const fetcher = vi.fn().mockRejectedValue(new ApiError('Bad Gateway', 502));
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'nope' }, []),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('maps a "no route to agent" message to the unavailable state', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('no route to agent xyz'));
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'nope' }, []),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
  });

  it('surfaces generic failures as errors with the rejection message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'fallback' }, []),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('boom');
    expect(result.current.unavailable).toBe(false);
  });

  it('falls back to the configured message when the rejection has none', async () => {
    const fetcher = vi.fn().mockRejectedValue({});
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'fallback' }, []),
    );
    await waitFor(() => expect(result.current.error).toBe('fallback'));
  });

  it('honours a custom isUnavailable classifier', async () => {
    const fetcher = vi.fn().mockRejectedValue(new ApiError('not configured', 503));
    const { result } = renderHook(() =>
      useAgentResource(
        fetcher,
        {
          initial: [] as string[],
          fallbackError: 'nope',
          isUnavailable: err => err instanceof ApiError && err.status === 503,
        },
        [],
      ),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('reload refetches and clears a previous error', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(['ok']);
    const { result } = renderHook(() =>
      useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'nope' }, []),
    );
    await waitFor(() => expect(result.current.error).toBe('boom'));
    await act(() => result.current.reload());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(['ok']);
    expect(result.current.error).toBeNull();
  });

  it('refetches when deps change', async () => {
    const fetcher = vi.fn().mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ id }) => useAgentResource(fetcher, { initial: [] as string[], fallbackError: 'n' }, [id]),
      { initialProps: { id: 'a' } },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ id: 'b' });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
