import { useCallback, useEffect, useMemo, useRef } from "react";

export interface SingleFlightOperationController {
  begin: () => number | null;
  cancel: () => void;
  complete: (token: number) => boolean;
  isCurrent: (token: number) => boolean;
}

export function useSingleFlightOperation(): SingleFlightOperationController {
  const revisionRef = useRef(0);
  const activeTokenRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const begin = useCallback(() => {
    if (activeTokenRef.current !== null) return null;
    revisionRef.current += 1;
    activeTokenRef.current = revisionRef.current;
    return activeTokenRef.current;
  }, []);

  const cancel = useCallback(() => {
    revisionRef.current += 1;
    activeTokenRef.current = null;
  }, []);

  const isCurrent = useCallback(
    (token: number) => mountedRef.current
      && activeTokenRef.current === token
      && revisionRef.current === token,
    [],
  );

  const complete = useCallback((token: number) => {
    if (
      !mountedRef.current
      || activeTokenRef.current !== token
      || revisionRef.current !== token
    ) return false;
    activeTokenRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  return useMemo(
    () => ({ begin, cancel, complete, isCurrent }),
    [begin, cancel, complete, isCurrent],
  );
}
