import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { RuntimeHttpExceptionFilter } from '../core/http/runtime-http-exception.filter';
import { EventInboxModule } from '../modules/event-inbox/event-inbox.module';

@Module({
  imports: [EventInboxModule],
  providers: [{ provide: APP_FILTER, useClass: RuntimeHttpExceptionFilter }],
})
export class EventInboxAppModule {}
