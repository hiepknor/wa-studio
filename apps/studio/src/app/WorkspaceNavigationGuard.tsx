import { createContext, type ReactNode, useContext, useEffect } from "react";

const WorkspaceNavigationGuardContext = createContext<
  ((dirty: boolean) => void) | null
>(null);

interface WorkspaceNavigationGuardProviderProps {
  children: ReactNode;
  onDirtyChange: (dirty: boolean) => void;
}

export function WorkspaceNavigationGuardProvider({
  children,
  onDirtyChange,
}: WorkspaceNavigationGuardProviderProps) {
  return (
    <WorkspaceNavigationGuardContext.Provider value={onDirtyChange}>
      {children}
    </WorkspaceNavigationGuardContext.Provider>
  );
}

export function useWorkspaceNavigationGuard(dirty: boolean) {
  const setDirty = useContext(WorkspaceNavigationGuardContext);
  useEffect(() => {
    setDirty?.(dirty);
    return () => setDirty?.(false);
  }, [dirty, setDirty]);
}
