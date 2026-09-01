import { createHash } from 'node:crypto';
import { BadRequestException, ForbiddenException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { isISO8601, isUUID } from 'class-validator';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import type { CampaignQueryDto } from '../../contracts/campaigns/campaign-query.dto';
import type { CampaignPreflightRequestDto } from '../../contracts/campaigns/campaign-preflight.dto';
import type { CreateCampaignDto } from '../../contracts/campaigns/create-campaign.dto';
import { CampaignScheduleType } from '../../contracts/campaigns/create-campaign.dto';
import type { DeleteCampaignQueryDto } from '../../contracts/campaigns/delete-campaign.dto';
import type { UpdateCampaignDto } from '../../contracts/campaigns/update-campaign.dto';
import {
  CampaignContentType,
  type CampaignContentDto,
  type CampaignContentInputDto,
} from '../../contracts/campaigns/campaign-content.dto';
import { MediaAssetKind } from '../../contracts/media-assets/media-asset.dto';
import { MediaAssetService } from '../media-assets/media-asset.service';
import { CampaignRepository } from './campaign.repository';
import { CampaignPreflightService } from './campaign-preflight.service';
import { CampaignError } from './campaign-error';

@Injectable()
export class CampaignService {
  constructor(
    private readonly repository: CampaignRepository,
    private readonly preflights: CampaignPreflightService,
    private readonly media: MediaAssetService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async create(dto: CreateCampaignDto, rawIdempotencyKey: string | undefined) {
    this.assertAllowedSession(dto.sessionId);
    const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required');
    }
    if (!isUUID(idempotencyKey)) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be a UUID');
    }
    if (!await this.repository.sessionExists(dto.sessionId)) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SESSION_NOT_FOUND',
        'Session is not synchronized');
    }
    const schedule = this.resolveSchedule(dto.scheduleType, dto.scheduledAt);
    const content = await this.resolveContent(dto.sessionId, dto.content, dto.text, true);
    const input = {
      sessionId: dto.sessionId,
      name: this.nonBlank(dto.name, 'name'),
      content,
      ...schedule,
    };
    const requestHash = createHash('sha256').update(JSON.stringify({
      ...input,
      scheduledAt: input.scheduledAt?.toISOString() ?? null,
    })).digest('hex');
    const result = await this.repository.create({ ...input, idempotencyKey, requestHash });
    if (result.requestHash !== requestHash) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with a different campaign payload');
    }
    if (result.deleted) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_IDEMPOTENCY_KEY_RETIRED',
        'Idempotency-Key belongs to a deleted campaign and cannot be reused');
    }
    return { campaign: result.campaign, created: result.created };
  }

  async list(query: CampaignQueryDto) {
    if (query.sessionId) this.assertAllowedSession(query.sessionId);
    const normalizedQuery = query.query?.trim();
    const result = await this.repository.list({
      allowedSessionIds: this.config.OPENWA_ALLOWED_SESSION_IDS,
      sessionId: query.sessionId,
      query: normalizedQuery || undefined,
      exactCampaignId: normalizedQuery && isUUID(normalizedQuery) ? normalizedQuery : undefined,
      statuses: query.status,
      scheduleTypes: query.scheduleType,
      limit: query.limit,
      offset: query.offset,
    });
    return { data: result.data, meta: { total: result.total, limit: query.limit, offset: query.offset } };
  }

  async get(id: string) {
    const campaign = await this.repository.find(id);
    if (!campaign || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(campaign.sessionId)) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    return campaign;
  }

  async update(id: string, dto: UpdateCampaignDto) {
    const current = await this.get(id);
    if (current.status !== 'DRAFT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Only DRAFT campaigns can be edited');
    }
    if (dto.expectedRevision !== undefined && dto.expectedRevision !== current.revision) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_REVISION_CONFLICT',
        'Campaign changed after it was loaded', {
          expectedRevision: dto.expectedRevision, currentRevision: current.revision,
        });
    }
    const schedulingTouched = dto.scheduleType !== undefined || dto.scheduledAt !== undefined;
    const schedule = schedulingTouched
      ? this.resolveSchedule(
          dto.scheduleType ?? current.scheduleType,
          dto.scheduledAt === undefined ? current.scheduledAt?.toISOString() : dto.scheduledAt,
        )
      : { scheduleType: current.scheduleType, scheduledAt: current.scheduledAt };
    if (dto.content !== undefined && dto.text !== undefined) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'content and the legacy text field cannot be supplied together');
    }
    const content = dto.content !== undefined || dto.text !== undefined
      ? await this.resolveContent(current.sessionId, dto.content, dto.text, false)
      : current.content;
    const updated = await this.repository.update(id, {
      name: dto.name === undefined ? current.name : this.nonBlank(dto.name, 'name'),
      content,
      ...schedule,
    }, current.revision);
    if (!updated) {
      const latest = await this.repository.find(id);
      if (latest?.status === 'DRAFT') {
        throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_REVISION_CONFLICT',
          'Campaign changed while the update was being applied', {
            expectedRevision: current.revision, currentRevision: latest.revision,
          });
      }
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Campaign is no longer editable');
    }
    return updated;
  }

  async listTargets(id: string) {
    const snapshot = await this.repository.getTargetsSnapshot(id);
    if (!snapshot || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(snapshot.campaign.sessionId)) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    return {
      data: snapshot.targets,
      targetsRevision: snapshot.campaign.targetsRevision,
      source: snapshot.source,
    };
  }

  async replaceTargets(id: string, groupIds: string[], expectedTargetsRevision?: number) {
    const campaign = await this.get(id);
    if (campaign.status !== 'DRAFT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Only DRAFT campaign targets can be edited');
    }
    if (expectedTargetsRevision !== undefined && expectedTargetsRevision !== campaign.targetsRevision) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_TARGETS_REVISION_CONFLICT',
        'Campaign targets changed after they were loaded', {
          expectedTargetsRevision, currentTargetsRevision: campaign.targetsRevision,
        });
    }
    if (groupIds.length > 1000) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_LIMIT_EXCEEDED',
        'A campaign can contain at most 1000 unique group targets', { maximum: 1000 });
    }
    if (new Set(groupIds).size !== groupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_DUPLICATE',
        'Duplicate group target IDs are not allowed');
    }
    const result = await this.repository.replaceTargets(id, groupIds, campaign.targetsRevision);
    if (!result.campaignFound) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    if (!result.campaignEditable) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Campaign is no longer editable');
    }
    if (result.revisionConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_TARGETS_REVISION_CONFLICT',
        'Campaign targets changed while the replacement was being applied', {
          expectedTargetsRevision: campaign.targetsRevision,
        });
    }
    if (result.mismatchedGroupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_SESSION_MISMATCH',
        'One or more groups do not belong to the campaign session',
        { invalidTargetCount: result.mismatchedGroupIds.length });
    }
    if (result.missingGroupIds.length) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_NOT_FOUND',
        'One or more groups are not present in the durable group read model',
        { invalidTargetCount: result.missingGroupIds.length });
    }
    return { data: result.targets, targetsRevision: result.targetsRevision, source: result.source };
  }

  async applyGroupListTargets(id: string, input: {
    groupListId: string;
    expectedMembershipRevision?: number;
    expectedTargetsRevision?: number;
  }) {
    const campaign = await this.get(id);
    if (campaign.status !== 'DRAFT') {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Only DRAFT campaign targets can be edited');
    }
    if (input.expectedTargetsRevision !== undefined
      && input.expectedTargetsRevision !== campaign.targetsRevision) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_TARGETS_REVISION_CONFLICT',
        'Campaign targets changed after they were loaded', {
          expectedTargetsRevision: input.expectedTargetsRevision,
          currentTargetsRevision: campaign.targetsRevision,
        });
    }
    const result = await this.repository.applyGroupListTargets({
      campaignId: id,
      groupListId: input.groupListId,
      expectedTargetsRevision: campaign.targetsRevision,
      expectedMembershipRevision: input.expectedMembershipRevision,
    });
    if (!result.campaignFound) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    if (!result.campaignEditable) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_NOT_EDITABLE',
        'Campaign is no longer editable');
    }
    if (result.targetRevisionConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_TARGETS_REVISION_CONFLICT',
        'Campaign targets changed while the saved list was being applied');
    }
    if (!result.sourceFound) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_TARGET_SOURCE_NOT_FOUND',
        'Saved group list not found');
    }
    if (result.sourceSessionMismatch) {
      if (!result.sourceSessionId
        || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(result.sourceSessionId)) {
        throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_TARGET_SOURCE_NOT_FOUND',
          'Saved group list not found');
      }
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_TARGET_SOURCE_SESSION_MISMATCH',
        'Saved group list does not belong to the campaign session');
    }
    if (result.sourceRevisionConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_TARGET_SOURCE_REVISION_CONFLICT',
        'Saved group-list membership changed after it was loaded', {
          expectedMembershipRevision: input.expectedMembershipRevision,
          currentMembershipRevision: result.currentSourceRevision,
        });
    }
    return { data: result.targets, targetsRevision: result.targetsRevision, source: result.source };
  }

  async preflight(id: string, dto: CampaignPreflightRequestDto) {
    const snapshot = await this.repository.getPreflightSnapshot(id);
    if (!snapshot || !this.config.OPENWA_ALLOWED_SESSION_IDS.includes(snapshot.campaign.sessionId)) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    const { campaign, targets } = snapshot;
    const report = await this.preflights.evaluate({
      executionMode: dto.executionMode,
      sessionId: campaign.sessionId,
      content: campaign.content,
      targets,
      campaignRevision: campaign.revision,
      targetsRevision: campaign.targetsRevision,
    });
    return this.preflights.withLiveLaunchToken({
      campaignId: campaign.id,
      sessionId: campaign.sessionId,
      report,
    });
  }

  async delete(id: string, query: DeleteCampaignQueryDto): Promise<void> {
    const result = await this.repository.delete({
      id,
      allowedSessionIds: this.config.OPENWA_ALLOWED_SESSION_IDS,
      expectedRevision: query.expectedRevision,
      expectedTargetsRevision: query.expectedTargetsRevision,
    });
    if (!result.found) {
      throw new CampaignError(HttpStatus.NOT_FOUND, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
    }
    if (result.alreadyDeleted || result.deleted) return;
    if (result.revisionConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_REVISION_CONFLICT',
        'Campaign content or targets changed after deletion was requested', {
          expectedRevision: query.expectedRevision,
          expectedTargetsRevision: query.expectedTargetsRevision,
          currentRevision: result.currentRevision,
          currentTargetsRevision: result.currentTargetsRevision,
        });
    }
    if (result.stateConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_DELETE_STATE_CONFLICT',
        'ACTIVE or PAUSED campaigns must have their LIVE run cancelled before deletion', {
          currentStatus: result.currentStatus,
        });
    }
    if (result.runConflict) {
      throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_DELETE_RUN_CONFLICT',
        'Campaign has a non-terminal run that must be cancelled before deletion');
    }
    throw new CampaignError(HttpStatus.CONFLICT, 'CAMPAIGN_DELETE_STATE_CONFLICT',
      'Campaign could not be deleted from its current state');
  }

  private assertAllowedSession(sessionId: string): void {
    if (!this.config.OPENWA_ALLOWED_SESSION_IDS.includes(sessionId)) {
      throw new ForbiddenException('Session is not in OPENWA_ALLOWED_SESSION_IDS');
    }
  }

  private nonBlank(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException(`${field} must not be blank`);
    return trimmed;
  }

  private async resolveContent(
    sessionId: string,
    content: CampaignContentInputDto | undefined,
    legacyText: string | undefined,
    required: boolean,
  ): Promise<CampaignContentDto> {
    if (content !== undefined && legacyText !== undefined) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Exactly one of content or the legacy text field may be supplied');
    }
    if (content === undefined) {
      if (legacyText === undefined) {
        throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
          required ? 'Campaign content is required' : 'Campaign content update is required');
      }
      return { type: CampaignContentType.TEXT, text: this.nonBlank(legacyText, 'text') };
    }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Campaign content must be an object');
    }
    if (content.type === CampaignContentType.TEXT) {
      this.assertContentKeys(content, ['type', 'text']);
      if (typeof content.text !== 'string') {
        throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
          'Text campaign content requires text');
      }
      const text = this.nonBlank(content.text, 'content.text');
      if (text.length > 4096) {
        throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
          'Text campaign content must not exceed 4096 characters');
      }
      return { type: CampaignContentType.TEXT, text };
    }
    if (content.type !== CampaignContentType.IMAGE) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Campaign content type must be TEXT or IMAGE');
    }
    this.assertContentKeys(content, ['type', 'mediaAssetId', 'caption']);
    if (typeof content.mediaAssetId !== 'string' || !isUUID(content.mediaAssetId)) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Media campaign content requires a valid mediaAssetId');
    }
    if (content.caption !== undefined && typeof content.caption !== 'string') {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Media campaign caption must be a string');
    }
    const caption = content.caption?.trim() ?? '';
    if (caption.length > 1024) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        'Media campaign caption must not exceed 1024 characters');
    }
    const asset = await this.media.resolveForCampaign(content.mediaAssetId, sessionId, MediaAssetKind.IMAGE);
    return {
      type: content.type,
      mediaAssetId: asset.id,
      caption,
      filename: asset.filename,
      mimeType: asset.mimeType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
    };
  }

  private assertContentKeys(content: object, allowed: string[]): void {
    const unexpected = Object.keys(content).filter(key => !allowed.includes(key));
    if (unexpected.length) {
      throw new CampaignError(HttpStatus.BAD_REQUEST, 'CAMPAIGN_CONTENT_INVALID',
        `Unexpected campaign content field: ${unexpected[0]}`);
    }
  }

  private resolveSchedule(scheduleType: CampaignScheduleType, value?: string | null): {
    scheduleType: CampaignScheduleType;
    scheduledAt: Date | null;
  } {
    if (scheduleType === CampaignScheduleType.IMMEDIATE) {
      return { scheduleType, scheduledAt: null };
    }
    if (!value) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_REQUIRED',
        'scheduledAt is required for ONCE campaigns');
    }
    const hasExplicitTimeAndZone = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
    if (!hasExplicitTimeAndZone || !isISO8601(value, { strict: true, strictSeparator: true })) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_INVALID',
        'scheduledAt must be a valid ISO-8601 date-time');
    }
    const scheduledAt = new Date(value);
    if (scheduledAt <= new Date()) {
      throw new CampaignError(HttpStatus.UNPROCESSABLE_ENTITY, 'CAMPAIGN_SCHEDULE_IN_PAST',
        'scheduledAt must be in the future');
    }
    return { scheduleType, scheduledAt };
  }
}
