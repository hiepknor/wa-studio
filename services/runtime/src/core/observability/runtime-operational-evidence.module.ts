import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { RuntimeOperationalEvidenceService } from './runtime-operational-evidence.service';

@Module({
  imports: [DatabaseModule],
  providers: [RuntimeOperationalEvidenceService],
  exports: [RuntimeOperationalEvidenceService],
})
export class RuntimeOperationalEvidenceModule {}
