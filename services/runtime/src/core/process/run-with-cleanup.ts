type Task<T> = () => T | Promise<T>;

export async function runWithCleanup<T>(
  operation: Task<T>,
  cleanup: Task<unknown>,
): Promise<T> {
  let operationCompleted = false;
  let result!: T;
  let operationFailure: unknown;
  try {
    result = await operation();
    operationCompleted = true;
  } catch (error) {
    operationFailure = error;
  }

  let cleanupCompleted = false;
  let cleanupFailure: unknown;
  try {
    await cleanup();
    cleanupCompleted = true;
  } catch (error) {
    cleanupFailure = error;
  }

  if (!operationCompleted) {
    if (!cleanupCompleted) {
      throw new AggregateError(
        [operationFailure, cleanupFailure],
        'Operation failed and cleanup also failed',
      );
    }
    throw operationFailure;
  }
  if (!cleanupCompleted) throw cleanupFailure;
  return result;
}

export async function runWithStartupRollback<T>(
  startup: Task<T>,
  rollback: Task<unknown>,
): Promise<T> {
  try {
    return await startup();
  } catch (startupFailure) {
    return runWithCleanup(
      async () => { throw startupFailure; },
      rollback,
    );
  }
}

export async function runCleanupTasks(tasks: ReadonlyArray<Task<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason as unknown);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Multiple cleanup tasks failed');
}
