import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { OpenWASafetyController } from './openwa-safety.controller';
import { OpenWASafetyService } from './openwa-safety.service';

@Module({
  imports: [OpenWAModule],
  controllers: [OpenWASafetyController],
  providers: [OpenWASafetyService],
  exports: [OpenWASafetyService],
})
export class OpenWASafetyModule {}
