import { Module } from '@nestjs/common';
import { StateRevisionsController } from './state-revisions.controller';
import { StateRevisionsRepository } from './state-revisions.repository';
import { StateRevisionsService } from './state-revisions.service';

@Module({
  controllers: [StateRevisionsController],
  providers: [StateRevisionsRepository, StateRevisionsService],
})
export class StateRevisionsModule {}
