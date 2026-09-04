import { Module } from '@nestjs/common';
import { RuntimeDispatchReadinessModule } from '../../core/dispatch-readiness/runtime-dispatch-readiness.module';
import { OpenWACompatibilityService } from './openwa-compatibility.service';
import { OpenWAClient } from './openwa.client';
import { OpenWASafetyGovernorService } from './safety/openwa-safety-governor.service';
import { OpenWASafetyRepository } from './safety/openwa-safety.repository';

@Module({
  imports: [RuntimeDispatchReadinessModule],
  providers: [
    OpenWACompatibilityService,
    OpenWAClient,
    OpenWASafetyRepository,
    OpenWASafetyGovernorService,
  ],
  exports: [
    OpenWACompatibilityService,
    OpenWAClient,
    OpenWASafetyGovernorService,
    OpenWASafetyRepository,
    RuntimeDispatchReadinessModule,
  ],
})
export class OpenWAModule {}
