import { Module } from '@nestjs/common';
import { OpenWACompatibilityService } from './openwa-compatibility.service';
import { OpenWAClient } from './openwa.client';
import { OpenWASafetyGovernorService } from './safety/openwa-safety-governor.service';
import { OpenWASafetyRepository } from './safety/openwa-safety.repository';

@Module({
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
  ],
})
export class OpenWAModule {}
