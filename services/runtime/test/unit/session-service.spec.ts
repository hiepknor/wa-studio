import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../../src/core/config/runtime-config';
import type { OpenWAClient } from '../../src/integrations/openwa/openwa.client';
import type { GatewayRepository } from '../../src/modules/gateway/gateway.repository';
import { SessionService } from '../../src/modules/gateway/session.service';

const allowedSessionId = '00000000-0000-4000-8000-000000000001';
const config = {
  OPENWA_ALLOWED_SESSION_IDS: [allowedSessionId],
} as RuntimeConfig;

describe('SessionService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('refreshes allowlisted sessions before returning the durable read model', async () => {
    const session = { id: allowedSessionId };
    const repository = {
      upsertSession: vi.fn().mockResolvedValue(session),
      listSessions: vi.fn().mockResolvedValue([session]),
    };
    const openwa = {
      listSessions: vi.fn().mockResolvedValue([session, { id: 'not-allowed' }]),
    };

    await expect(new SessionService(
      repository as unknown as GatewayRepository,
      openwa as unknown as OpenWAClient,
      config,
    ).list()).resolves.toEqual({ data: [session] });

    expect(repository.upsertSession).toHaveBeenCalledOnce();
    expect(repository.upsertSession).toHaveBeenCalledWith(session);
  });

  it('keeps the local workspace attachable when OpenWA is unavailable', async () => {
    const snapshot = [{ id: allowedSessionId, name: 'Cached session' }];
    const repository = {
      upsertSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue(snapshot),
    };
    const openwa = {
      listSessions: vi.fn().mockRejectedValue(new Error('OpenWA unavailable')),
    };

    await expect(new SessionService(
      repository as unknown as GatewayRepository,
      openwa as unknown as OpenWAClient,
      config,
    ).list()).resolves.toEqual({ data: snapshot });

    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(repository.listSessions).toHaveBeenCalledWith([allowedSessionId]);
  });
});
