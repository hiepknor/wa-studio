import { Module } from '@nestjs/common';
import { ActivityController } from './activity.controller';
import { ActivityRepository } from './activity.repository';
import { ActivityService } from './activity.service';

@Module({
  controllers: [ActivityController],
  providers: [ActivityRepository, ActivityService],
})
export class ActivityModule {}
