import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SchedulerAppModule } from '../app/scheduler-app.module';
import { SchedulerRunnerService } from '../modules/orchestration/scheduler-runner.service';
import { JsonLogger } from '../core/observability/json-logger';
import { runWithCleanup } from '../core/process/run-with-cleanup';

export async function runScheduler(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerAppModule, { logger: new JsonLogger('scheduler') });
  await runWithCleanup(
    () => app.get(SchedulerRunnerService).run(),
    () => app.close(),
  );
}

if (require.main === module) {
  runScheduler().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
