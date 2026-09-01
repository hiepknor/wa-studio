import { useCallback, useEffect, useMemo, useRef } from "react";

export interface LatestOperationController {
  begin: () => number;
  cancel: () => void;
  isCurrent: (token: number) => boolean;
}

export function useLatestOperation(): LatestOperationController {
  const revisionRef = useRef(0);
  const mountedRef = useRef(true);

  const begin = useCallback(() => {
    revisionRef.current += 1;
    return revisionRef.current;
  }, []);
  const cancel = useCallback(() => {
    revisionRef.current += 1;
  }, []);
  const isCurrent = useCallback(
    (token: number) => mountedRef.current && token === revisionRef.current,
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancel();
    };
  }, [cancel]);

  return useMemo(
    () => ({ begin, cancel, isCurrent }),
    [begin, cancel, isCurrent],
  );
}
