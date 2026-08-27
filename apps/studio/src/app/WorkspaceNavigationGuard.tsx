import { createContext, type ReactNode, useContext, useEffect } from "react";

export interface WorkspaceNavigationGuard {
  busy?: boolean;
  busyLabel?: string;
  message: string;
  settledMessage?: string;
  settledTitle?: string;
  title: string;
}

export interface WorkspaceNavigationDialogCopy {
  message: string;
  title: string;
}

export function resolveWorkspaceNavigationDialogCopy(
  currentGuard: WorkspaceNavigationGuard | null,
  pendingGuard: WorkspaceNavigationGuard | null,
): WorkspaceNavigationDialogCopy {
  if (!currentGuard && pendingGuard?.busy) {
    return {
      message: pendingGuard.settledMessage
        ?? "The operation has finished. Continue to the requested destination.",
      title: pendingGuard.settledTitle ?? "Operation finished",
    };
  }
  const guard = currentGuard ?? pendingGuard;
  return {
    message: guard?.message ?? "",
    title: guard?.title ?? "Discard unsaved changes?",
  };
}

const WorkspaceNavigationGuardContext = createContext<
  ((guard: WorkspaceNavigationGuard | null) => void) | null
>(null);

interface WorkspaceNavigationGuardProviderProps {
  children: ReactNode;
  onGuardChange: (guard: WorkspaceNavigationGuard | null) => void;
}

export function WorkspaceNavigationGuardProvider({
  children,
  onGuardChange,
}: WorkspaceNavigationGuardProviderProps) {
  return (
    <WorkspaceNavigationGuardContext.Provider value={onGuardChange}>
      {children}
    </WorkspaceNavigationGuardContext.Provider>
  );
}

export function useWorkspaceNavigationGuard(
  dirty: boolean,
  {
    busy,
    busyLabel,
    message,
    settledMessage,
    settledTitle,
    title,
  }: WorkspaceNavigationGuard,
) {
  const setGuard = useContext(WorkspaceNavigationGuardContext);
  useEffect(() => {
    setGuard?.(dirty ? {
      ...(busy !== undefined ? { busy } : {}),
      ...(busyLabel !== undefined ? { busyLabel } : {}),
      message,
      ...(settledMessage !== undefined ? { settledMessage } : {}),
      ...(settledTitle !== undefined ? { settledTitle } : {}),
      title,
    } : null);
    return () => setGuard?.(null);
  }, [busy, busyLabel, dirty, message, setGuard, settledMessage, settledTitle, title]);
}
