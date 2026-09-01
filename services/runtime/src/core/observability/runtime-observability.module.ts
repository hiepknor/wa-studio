import { Module } from '@nestjs/common';
import { RuntimeMetricsController, RuntimeMetricsTokenGuard } from './runtime-metrics.controller';
import { RuntimeMetricsService } from './runtime-metrics.service';

@Module({
  controllers: [RuntimeMetricsController],
  providers: [RuntimeMetricsService, RuntimeMetricsTokenGuard],
  exports: [RuntimeMetricsService],
})
export class RuntimeObservabilityModule {}
