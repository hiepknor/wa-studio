import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { SchedulerAppModule } from '../app/scheduler-app.module';
import { SchedulerRunnerService } from '../modules/orchestration/scheduler-runner.service';
import { JsonLogger } from '../core/observability/json-logger';

export async function runScheduler(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SchedulerAppModule, { logger: new JsonLogger('scheduler') });
  try {
    await app.get(SchedulerRunnerService).run();
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  runScheduler().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
