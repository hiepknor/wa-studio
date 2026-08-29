import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { CampaignExecutionMode, CampaignPreflightDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CampaignTargetDto } from '../../contracts/campaigns/campaign-target.dto';
import { evaluateCampaignPreflight } from './campaign-preflight';
import { CampaignLivePreflightTokenService } from './campaign-live-preflight-token.service';
import { GatewayRepository } from '../gateway/gateway.repository';
import { CampaignContentType, type CampaignContentDto } from '../../contracts/campaigns/campaign-content.dto';
import { MediaAssetService } from '../media-assets/media-asset.service';
import { OpenWASafetyGovernorService } from '../../integrations/openwa/safety/openwa-safety-governor.service';

@Injectable()
export class CampaignPreflightService {
  constructor(
    private readonly gateway: GatewayRepository,
    private readonly liveTokens: CampaignLivePreflightTokenService,
    private readonly media: MediaAssetService,
    private readonly safety: OpenWASafetyGovernorService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async evaluate(input: {
    executionMode: CampaignExecutionMode;
    sessionId: string;
    content: CampaignContentDto;
    targets: CampaignTargetDto[];
    campaignRevision: number;
    targetsRevision: number;
  }) {
    const persistedSession = await this.gateway.findSession(input.sessionId);
    const session = persistedSession
      ? {
          status: persistedSession.status,
          engineLoaded: persistedSession.engineLoaded,
          restricted: persistedSession.restriction !== null,
        }
      : { status: 'missing', engineLoaded: false, restricted: true };
    const mediaReady = input.content.type === CampaignContentType.TEXT
      ? true
      : await this.media.matchesSnapshot(input.content, input.sessionId);
    const safety = await this.safety.sessionSnapshot(input.sessionId);
    return evaluateCampaignPreflight({
      executionMode: input.executionMode,
      content: input.content,
      mediaReady,
      targets: input.targets,
      session,
      liveSendsEnabled: this.config.ALLOW_LIVE_SENDS,
      safetyStatus: safety.status,
      campaignRevision: input.campaignRevision,
      targetsRevision: input.targetsRevision,
    });
  }

  withLiveLaunchToken(input: {
    campaignId: string;
    sessionId: string;
    report: CampaignPreflightDto;
  }): CampaignPreflightDto {
    if (input.report.executionMode !== 'LIVE' || input.report.status !== 'PASS') {
      return { ...input.report, liveLaunchToken: null, liveLaunchTokenExpiresAt: null };
    }
    const issued = this.liveTokens.issue(input);
    return {
      ...input.report,
      liveLaunchToken: issued.token,
      liveLaunchTokenExpiresAt: issued.expiresAt,
    };
  }
}
