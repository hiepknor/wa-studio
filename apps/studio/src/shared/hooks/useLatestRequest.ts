import { useCallback, useEffect, useMemo, useRef } from "react";

export interface LatestRequestController {
  begin: () => AbortSignal;
  cancel: () => void;
  complete: (signal: AbortSignal) => void;
  isCurrent: (signal: AbortSignal) => boolean;
}

export function useLatestRequest(): LatestRequestController {
  const controllerRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const begin = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }, []);

  const complete = useCallback((signal: AbortSignal) => {
    if (controllerRef.current?.signal === signal) controllerRef.current = null;
  }, []);

  const isCurrent = useCallback(
    (signal: AbortSignal) => controllerRef.current?.signal === signal && !signal.aborted,
    [],
  );

  useEffect(() => cancel, [cancel]);

  return useMemo(() => ({ begin, cancel, complete, isCurrent }), [
    begin,
    cancel,
    complete,
    isCurrent,
  ]);
}
