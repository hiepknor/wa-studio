import { Global, Module } from '@nestjs/common';
import { eventInboxConfig } from './event-inbox-config';

export const EVENT_INBOX_CONFIG = Symbol('EVENT_INBOX_CONFIG');

@Global()
@Module({
  providers: [{ provide: EVENT_INBOX_CONFIG, useFactory: eventInboxConfig }],
  exports: [EVENT_INBOX_CONFIG],
})
export class EventInboxConfigModule {}
