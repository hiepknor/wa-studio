import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';

const tokenPrefix = 'clp1';
const signatureContext = 'campaign-live-preflight:v1:';
const claimsSchema = z.object({
  version: z.literal(1),
  campaignId: z.uuid(),
  sessionId: z.uuid(),
  campaignRevision: z.number().int().min(1),
  targetsRevision: z.number().int().min(0),
  policyVersion: z.number().int().min(1),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  nonce: z.uuid(),
}).strict();

export type CampaignLivePreflightClaims = z.infer<typeof claimsSchema>;
export type CampaignLivePreflightTokenError = 'EXPIRED' | 'INVALID' | 'MISMATCH';

export class InvalidCampaignLivePreflightTokenError extends Error {
  constructor(readonly reason: CampaignLivePreflightTokenError) {
    super(`Campaign LIVE preflight token is ${reason.toLowerCase()}`);
    this.name = 'InvalidCampaignLivePreflightTokenError';
  }
}

@Injectable()
export class CampaignLivePreflightTokenService {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  issue(input: {
    campaignId: string;
    sessionId: string;
    report: CampaignPreflightDto;
  }): { token: string; expiresAt: Date } {
    if (input.report.executionMode !== 'LIVE' || input.report.status !== 'PASS') {
      throw new Error('A LIVE launch token can only be issued for a passing LIVE preflight');
    }
    const issuedAt = Math.floor(new Date(input.report.checkedAt).getTime() / 1000);
    const expiresAt = issuedAt + this.config.CAMPAIGN_LIVE_PREFLIGHT_TTL_SECONDS;
    const claims: CampaignLivePreflightClaims = {
      version: 1,
      campaignId: input.campaignId,
      sessionId: input.sessionId,
      campaignRevision: input.report.campaignRevision,
      targetsRevision: input.report.targetsRevision,
      policyVersion: input.report.policyVersion,
      issuedAt,
      expiresAt,
      nonce: randomUUID(),
    };
    const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return {
      token: `${tokenPrefix}.${payload}.${this.sign(payload)}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  verify(token: string, expected: {
    campaignId: string;
    sessionId: string;
    campaignRevision: number;
    targetsRevision: number;
  }, now = new Date(), options: { allowExpired?: boolean } = {}): CampaignLivePreflightClaims {
    const [prefix, payload, signature, ...remainder] = token.split('.');
    if (prefix !== tokenPrefix || !payload || !signature || remainder.length) {
      throw new InvalidCampaignLivePreflightTokenError('INVALID');
    }
    const supplied = Buffer.from(signature, 'base64url');
    const calculated = Buffer.from(this.sign(payload), 'base64url');
    if (signature !== supplied.toString('base64url')
      || supplied.length !== calculated.length
      || !timingSafeEqual(supplied, calculated)) {
      throw new InvalidCampaignLivePreflightTokenError('INVALID');
    }
    let claims: CampaignLivePreflightClaims;
    try {
      claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
    } catch {
      throw new InvalidCampaignLivePreflightTokenError('INVALID');
    }
    const nowSeconds = Math.floor(now.getTime() / 1000);
    if ((!options.allowExpired && claims.expiresAt <= nowSeconds) || claims.issuedAt > nowSeconds + 30) {
      throw new InvalidCampaignLivePreflightTokenError('EXPIRED');
    }
    if (claims.campaignId !== expected.campaignId
      || claims.sessionId !== expected.sessionId
      || claims.campaignRevision !== expected.campaignRevision
      || claims.targetsRevision !== expected.targetsRevision) {
      throw new InvalidCampaignLivePreflightTokenError('MISMATCH');
    }
    return claims;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.config.RUNTIME_API_KEY)
      .update(`${signatureContext}${payload}`)
      .digest('base64url');
  }
}
