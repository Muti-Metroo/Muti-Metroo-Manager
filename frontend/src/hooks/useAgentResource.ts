import { useCallback, useEffect, useState } from 'react';
import { isUnreachableError } from '../api/client';

export interface AgentResourceOptions<T> {
  // Value returned before the first fetch resolves (typically []).
  initial: T;
  // Used when the rejection carries no message.
  fallbackError: string;
  // Classifies failures that should surface as the "unavailable" state
  // (dedicated banner) rather than a generic error. Defaults to the
  // agent-unreachable check; the DNS tabs pass a 503 match instead.
  isUnavailable?: (err: unknown) => boolean;
}

export interface AgentResource<T> {
  data: T;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  setError: (msg: string | null) => void;
  setData: (value: T) => void;
  reload: () => Promise<void>;
}

// Shared fetch-on-mount scaffold for the agent-management tabs: runs
// fetcher whenever deps change and tracks loading/error/unavailable.
// Mutations use setError/setData for their feedback and call reload()
// to refetch.
export function useAgentResource<T>(
  fetcher: () => Promise<T>,
  options: AgentResourceOptions<T>,
  deps: readonly unknown[],
): AgentResource<T> {
  const { initial, fallbackError, isUnavailable = isUnreachableError } = options;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    try {
      setData(await fetcher());
    } catch (err: any) {
      const msg = err?.message || '';
      if (isUnavailable(err)) {
        setUnavailable(true);
      } else {
        setError(msg || fallbackError);
      }
    } finally {
      setLoading(false);
    }
  }, deps);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, loading, error, unavailable, setError, setData, reload };
}
