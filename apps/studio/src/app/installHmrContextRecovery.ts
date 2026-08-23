const RECOVERABLE_CONTEXT_ERRORS = [
  "useToast must be used inside ToastProvider",
  "useRuntimeConnection must be used inside RuntimeConnectionProvider",
] as const;

const RECOVERY_WINDOW_MS = 2_500;

interface HmrContextRecoveryOptions {
  eventTarget?: Window;
  now?: () => number;
  reload?: () => void;
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return typeof reason === "string" ? reason : "";
}

export function installHmrContextRecovery(
  hot: NonNullable<ImportMeta["hot"]>,
  {
    eventTarget = window,
    now = Date.now,
    reload = () => window.location.reload(),
  }: HmrContextRecoveryOptions = {},
): () => void {
  let updateDeadline = 0;
  let updateSeen = false;
  let reloading = false;

  const beforeUpdate = () => {
    updateSeen = true;
    updateDeadline = now() + RECOVERY_WINDOW_MS;
  };

  const recover = (reason: unknown) => {
    const message = errorMessage(reason);
    if (
      reloading
      || !updateSeen
      || now() > updateDeadline
      || !RECOVERABLE_CONTEXT_ERRORS.some((candidate) => message.includes(candidate))
    ) return;
    reloading = true;
    console.warn("Reloading WA Studio after a Vite HMR context mismatch.", reason);
    reload();
  };

  const handleError = (event: ErrorEvent) => recover(event.error ?? event.message);
  const handleRejection = (event: PromiseRejectionEvent) => recover(event.reason);

  hot.on("vite:beforeUpdate", beforeUpdate);
  eventTarget.addEventListener("error", handleError);
  eventTarget.addEventListener("unhandledrejection", handleRejection);

  return () => {
    hot.off("vite:beforeUpdate", beforeUpdate);
    eventTarget.removeEventListener("error", handleError);
    eventTarget.removeEventListener("unhandledrejection", handleRejection);
  };
}
