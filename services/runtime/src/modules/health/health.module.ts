import { Module } from '@nestjs/common';
import { RuntimeOperationalEvidenceModule } from '../../core/observability/runtime-operational-evidence.module';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { HealthController } from './health.controller';

@Module({
  imports: [OpenWAModule, RuntimeOperationalEvidenceModule],
  controllers: [HealthController],
})
export class HealthModule {}
