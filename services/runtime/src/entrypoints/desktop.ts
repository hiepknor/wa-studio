import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DesktopAppModule } from '../app/desktop-app.module';
import { runtimeConfig } from '../core/config/runtime-config';
import { configureApi } from '../core/http/configure-api';
import { JsonLogger } from '../core/observability/json-logger';
import { terminationSignal } from '../core/process/termination-signal';
import { runCleanupTasks, runWithCleanup } from '../core/process/run-with-cleanup';
import { SchedulerRunnerService } from '../modules/orchestration/scheduler-runner.service';
import { WorkerRunnerService } from '../modules/orchestration/worker-runner.service';

export async function runDesktop(): Promise<void> {
  const config = runtimeConfig();
  const app = await NestFactory.create<NestExpressApplication>(DesktopAppModule, {
    rawBody: true,
    bodyParser: false,
    logger: new JsonLogger('desktop'),
  });
  configureApi(app);
  const worker = app.get(WorkerRunnerService);
  const scheduler = app.get(SchedulerRunnerService);
  const termination = terminationSignal();
  await runWithCleanup(
    async () => {
      await worker.start();
      await scheduler.start();
      await app.listen(config.PORT, config.RUNTIME_BIND_HOST);
      const failure = await Promise.race([
        termination.promise.then(() => null),
        scheduler.waitForFailure(),
      ]);
      if (failure) throw failure;
    },
    async () => {
      termination.dispose();
      stopAcceptingHttpRequests(app);
      await runWithCleanup(
        () => runCleanupTasks([
          () => scheduler.stop(),
          () => worker.stop(),
        ]),
        () => app.close(),
      );
    },
  );
}

function stopAcceptingHttpRequests(app: NestExpressApplication): void {
  const server = app.getHttpServer() as { listening?: boolean; close(): unknown };
  if (server.listening !== false) server.close();
}

if (require.main === module) {
  runDesktop().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
