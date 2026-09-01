import { Module } from '@nestjs/common';
import { ApiAppModule } from './api-app.module';
import { SchedulerOrchestrationModule } from '../modules/orchestration/scheduler-orchestration.module';
import { WorkerOrchestrationModule } from '../modules/orchestration/worker-orchestration.module';

@Module({
  imports: [ApiAppModule, WorkerOrchestrationModule, SchedulerOrchestrationModule],
})
export class DesktopAppModule {}
