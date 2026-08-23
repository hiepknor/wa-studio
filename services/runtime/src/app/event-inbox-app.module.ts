import { Module } from '@nestjs/common';
import { EventInboxModule } from '../modules/event-inbox/event-inbox.module';

@Module({ imports: [EventInboxModule] })
export class EventInboxAppModule {}
