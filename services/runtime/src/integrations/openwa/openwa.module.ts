import { Module } from '@nestjs/common';
import { OpenWACompatibilityService } from './openwa-compatibility.service';
import { OpenWAClient } from './openwa.client';

@Module({
  providers: [OpenWACompatibilityService, OpenWAClient],
  exports: [OpenWACompatibilityService, OpenWAClient],
})
export class OpenWAModule {}
