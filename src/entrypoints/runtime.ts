import 'reflect-metadata';
import { migrateRuntimeDatabase } from '../core/database/runtime-migrations';
import { startParentProcessWatchdog } from '../core/process/parent-process-watchdog';
import { runtimeReleaseManifest } from '../core/release/runtime-release';

export type RuntimeCommand = 'api' | 'worker' | 'scheduler' | 'migrate' | 'manifest';

const runtimeCommands = new Set<RuntimeCommand>([
  'api',
  'worker',
  'scheduler',
  'migrate',
  'manifest',
]);

export function parseRuntimeCommand(argument: string | undefined): RuntimeCommand {
  if (argument && runtimeCommands.has(argument as RuntimeCommand)) {
    return argument as RuntimeCommand;
  }
  throw new Error(
    `Usage: wa-runtime <${[...runtimeCommands].join('|')}>`,
  );
}

export async function runRuntimeCommand(command: RuntimeCommand): Promise<void> {
  if (command === 'api' || command === 'worker' || command === 'scheduler') {
    startParentProcessWatchdog();
  }
  switch (command) {
    case 'api':
      await import('./api').then(module => module.runApi());
      return;
    case 'worker':
      await import('./worker').then(module => module.runWorker());
      return;
    case 'scheduler':
      await import('./scheduler').then(module => module.runScheduler());
      return;
    case 'migrate': {
      const result = await migrateRuntimeDatabase();
      for (const file of result.checksumsBackfilled) process.stdout.write(`Recorded checksum ${file}\n`);
      for (const file of result.applied) process.stdout.write(`Applied ${file}\n`);
      return;
    }
    case 'manifest':
      process.stdout.write(`${JSON.stringify(runtimeReleaseManifest())}\n`);
      return;
  }
}

async function main(): Promise<void> {
  await runRuntimeCommand(parseRuntimeCommand(process.argv[2]));
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
