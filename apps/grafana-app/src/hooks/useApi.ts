import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from '../api/client';
import type { Filters, Page } from '../api/types';

export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const loader = useRef(load);
  // Publish the current loader after commit, before the request effect runs.
  useEffect(() => {
    loader.current = load;
  });
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string; nonce: number; data?: T; error?: string }>();
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled) {
      return () => controller.abort();
    }
    loader
      .current(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ key, nonce, data });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState({ key, nonce, error: errorMessage(error) });
        }
      });
    return () => controller.abort();
  }, [key, nonce, enabled]);
  const current = enabled && state?.key === key && state.nonce === nonce ? state : undefined;
  return {
    loading: enabled && !current,
    data: current?.data,
    error: current?.error,
    retry: useCallback(() => setNonce((n) => n + 1), []),
  };
}

export function useCursor<T>(
  filters: Filters,
  load: (filters: Filters, signal: AbortSignal) => Promise<Page<T>>,
  enabled = true
) {
  const context = JSON.stringify(filters);
  const [position, setPosition] = useState<{ context: string; cursors: Array<string | undefined> }>({
    context,
    cursors: [undefined],
  });
  // Commit the new filter context, so A → B → A cannot resurrect A's old cursor.
  if (position.context !== context) {
    setPosition({ context, cursors: [undefined] });
  }
  const cursors = position.context === context ? position.cursors : [undefined];
  const cursor = cursors[cursors.length - 1];
  const resource = useResource(
    `${context}:${cursor ?? ''}`,
    (signal) => load({ ...filters, limit: 20, cursor }, signal),
    enabled
  );
  return {
    ...resource,
    page: cursors.length,
    previous: () => setPosition({ context, cursors: cursors.slice(0, -1) }),
    next: () => {
      if (resource.data?.next_cursor) {
        setPosition({ context, cursors: [...cursors, resource.data.next_cursor] });
      }
    },
  };
}

// Deliberate single-attempt mutations; never retain exception objects or auto retry.
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async <T>(operation: () => Promise<T>, success?: (value: T) => void) => {
    if (lock.current) {
      return;
    }
    lock.current = true;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await operation();
      if (mounted.current) {
        success?.(result);
      }
    } catch (failure: unknown) {
      if (mounted.current) {
        setError(errorMessage(failure));
      }
    } finally {
      lock.current = false;
      if (mounted.current) {
        setPending(false);
      }
    }
  };
  return { pending, error, notice, setNotice, run };
}
