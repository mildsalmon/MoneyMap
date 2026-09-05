import { useEffect, useState } from "react";

export function useQuery<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>(
    { key },
  );
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ key });
    load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setState({ key, error: error.message });
      });
    return () => controller.abort();
    // The key is the complete identity of the query, including mutation generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const current = state.key === key ? state : { key };
  return { ...current, reload: () => setRetry((value) => value + 1) };
}
