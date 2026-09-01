import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from '../app/worker-app.module';
import { WorkerRunnerService } from '../modules/orchestration/worker-runner.service';
import { JsonLogger } from '../core/observability/json-logger';
import { runWithCleanup } from '../core/process/run-with-cleanup';

export async function runWorker(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerAppModule, { logger: new JsonLogger('worker') });
  await runWithCleanup(
    () => app.get(WorkerRunnerService).run(),
    () => app.close(),
  );
}

if (require.main === module) {
  runWorker().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
