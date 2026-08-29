import { Module } from '@nestjs/common';
import { OpenWAModule } from '../../integrations/openwa/openwa.module';
import { HealthController } from './health.controller';

@Module({ imports: [OpenWAModule], controllers: [HealthController] })
export class HealthModule {}
