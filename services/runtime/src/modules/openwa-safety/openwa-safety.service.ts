import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import {
  OpenWASafetyControlActionDto,
  type OpenWASafetyControlDto,
  type OpenWASafetyProfileChangeDto,
} from '../../contracts/safety/openwa-safety.dto';
import { OpenWASafetyGovernorService } from '../../integrations/openwa/safety/openwa-safety-governor.service';
import { OpenWASafetyMutationConflictError } from '../../integrations/openwa/safety/openwa-safety.repository';

@Injectable()
export class OpenWASafetyService {
  constructor(
    private readonly governor: OpenWASafetyGovernorService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  snapshot(sessionId: string) {
    this.assertVisible(sessionId);
    return this.governor.sessionSnapshot(sessionId);
  }

  mutateControl(sessionId: string, idempotencyKey: string | undefined, input: OpenWASafetyControlDto) {
    const operationType = input.action === OpenWASafetyControlActionDto.BLOCK
      ? 'OPENWA_SESSION_BLOCK' as const
      : 'OPENWA_SESSION_RESUME' as const;
    return this.mutate(sessionId, idempotencyKey, operationType, {
      action: input.action,
      reason: input.reason?.trim() || undefined,
    });
  }

  mutateProfile(
    sessionId: string,
    idempotencyKey: string | undefined,
    input: OpenWASafetyProfileChangeDto,
  ) {
    return this.mutate(sessionId, idempotencyKey, 'OPENWA_SAFETY_PROFILE_CHANGE', {
      profile: input.profile,
    });
  }

  private async mutate(
    sessionId: string,
    idempotencyKey: string | undefined,
    operationType: 'OPENWA_SESSION_BLOCK' | 'OPENWA_SESSION_RESUME' | 'OPENWA_SAFETY_PROFILE_CHANGE',
    intent: { action?: OpenWASafetyControlActionDto; reason?: string; profile?: 'CANARY' | 'STANDARD' },
  ) {
    this.assertVisible(sessionId);
    if (!idempotencyKey || !isUUID(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a UUID');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({
      version: 1, operationType, sessionId, ...intent,
    })).digest('hex');
    try {
      return await this.governor.mutateSession({
        sessionId,
        operationType,
        idempotencyKey,
        requestHash,
        reason: intent.reason,
        profile: intent.profile,
      });
    } catch (error) {
      if (error instanceof OpenWASafetyMutationConflictError) throw new ConflictException(error.message);
      throw error;
    }
  }

  private assertVisible(sessionId: string): void {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new NotFoundException('Session safety state not found');
    }
  }
}
