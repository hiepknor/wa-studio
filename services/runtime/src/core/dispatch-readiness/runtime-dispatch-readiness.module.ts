import { Module } from '@nestjs/common';
import { RuntimeDispatchReadinessService } from './runtime-dispatch-readiness.service';

@Module({
  providers: [RuntimeDispatchReadinessService],
  exports: [RuntimeDispatchReadinessService],
})
export class RuntimeDispatchReadinessModule {}
