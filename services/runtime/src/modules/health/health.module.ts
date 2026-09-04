import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { HealthController } from './health.controller';
import { RuntimeReleaseEvidenceService } from './runtime-release-evidence.service';

@Module({
  imports: [OpenWAModule],
  controllers: [HealthController],
  providers: [RuntimeReleaseEvidenceService],
})
export class HealthModule {}
