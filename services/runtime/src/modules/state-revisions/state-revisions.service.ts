import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { StateRevisionsRepository } from './state-revisions.repository';

@Injectable()
export class StateRevisionsService {
  constructor(
    private readonly repository: StateRevisionsRepository,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async read(sessionId?: string) {
    if (sessionId && !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new NotFoundException('Resource not found');
    }
    return {
      sessionId: sessionId ?? null,
      ...await this.repository.read(sessionId ?? null, this.config.OPENWA_ALLOWED_SESSION_IDS),
    };
  }
}
