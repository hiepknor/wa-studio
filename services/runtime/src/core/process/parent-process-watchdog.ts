export interface ParentProcessWatchdogOptions {
  environment?: NodeJS.ProcessEnv;
  intervalMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  terminate?: () => void;
  log?: (message: string) => void;
}

const DEFAULT_INTERVAL_MS = 1_000;

export function parseParentProcessId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error('RUNTIME_PARENT_PID must be a positive process identifier');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error('RUNTIME_PARENT_PID must be a positive process identifier');
  }
  return parsed;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export function startParentProcessWatchdog(
  options: ParentProcessWatchdogOptions = {},
): () => void {
  const parentPid = parseParentProcessId(
    (options.environment ?? process.env).RUNTIME_PARENT_PID,
  );
  if (parentPid === undefined) return () => undefined;
  if (parentPid === process.pid) {
    throw new Error('RUNTIME_PARENT_PID cannot reference the Runtime process itself');
  }

  const isAlive = options.isProcessAlive ?? processIsAlive;
  const terminate = options.terminate ?? (() => process.kill(process.pid, 'SIGTERM'));
  const log = options.log ?? (message => process.stderr.write(`${message}\n`));
  let terminated = false;
  const timer = setInterval(() => {
    if (terminated) return;
    try {
      if (isAlive(parentPid)) return;
    } catch (error) {
      log(`[runtime-watchdog] Could not inspect desktop parent ${parentPid}: ${String(error)}`);
      return;
    }
    terminated = true;
    clearInterval(timer);
    log(`[runtime-watchdog] Desktop parent ${parentPid} exited; stopping Runtime.`);
    terminate();
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
