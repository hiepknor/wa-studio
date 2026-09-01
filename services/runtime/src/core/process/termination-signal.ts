export interface TerminationSignal {
  promise: Promise<void>;
  dispose(): void;
}

export function terminationSignal(): TerminationSignal {
  let stop: (() => void) | undefined;
  const dispose = (): void => {
    if (!stop) return;
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    stop = undefined;
  };
  const promise = new Promise<void>(resolve => {
    stop = () => {
      dispose();
      resolve();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  return { promise, dispose };
}
