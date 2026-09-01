import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { MediaAssetKind, type CreateMediaUploadDto } from '../../contracts/media-assets/media-asset.dto';
import { CampaignContentType, type CampaignContentDto } from '../../contracts/campaigns/campaign-content.dto';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import { SessionScopeService } from '../gateway/session-scope.service';
import { MediaAssetError } from './media-asset.error';
import { MediaAssetRepository, type StoredMediaAsset } from './media-asset.repository';

export const CAMPAIGN_MEDIA_CHUNK_BYTES = 393_216;
export const CAMPAIGN_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

@Injectable()
export class MediaAssetService {
  constructor(
    private readonly repository: MediaAssetRepository,
    private readonly sessions: SessionScopeService,
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  policy() {
    return {
      chunkSize: CAMPAIGN_MEDIA_CHUNK_BYTES,
      imageMimeTypes: [...CAMPAIGN_IMAGE_MIME_TYPES],
      imageMaxBytes: this.config.CAMPAIGN_MEDIA_IMAGE_MAX_BYTES,
      storageMaxBytes: this.config.CAMPAIGN_MEDIA_STORAGE_MAX_BYTES,
    };
  }

  async createUpload(dto: CreateMediaUploadDto, rawIdempotencyKey: string | undefined) {
    this.sessions.assertAllowed(dto.sessionId);
    const idempotencyKey = rawIdempotencyKey?.trim();
    if (!idempotencyKey) {
      throw new MediaAssetError(HttpStatus.BAD_REQUEST, 'MEDIA_UPLOAD_IDEMPOTENCY_KEY_REQUIRED',
        'Idempotency-Key header is required');
    }
    if (!isUUID(idempotencyKey)) {
      throw new MediaAssetError(HttpStatus.BAD_REQUEST, 'MEDIA_UPLOAD_IDEMPOTENCY_KEY_INVALID',
        'Idempotency-Key must be a UUID');
    }
    const filename = this.sanitizeFilename(dto.filename);
    const mimeType = dto.mimeType.trim().toLowerCase();
    this.assertPolicy(dto.kind, mimeType, dto.byteSize);
    const input = {
      sessionId: dto.sessionId,
      kind: dto.kind,
      filename,
      mimeType,
      byteSize: dto.byteSize,
      sha256: dto.sha256,
      chunkSize: CAMPAIGN_MEDIA_CHUNK_BYTES,
      expiresAt: new Date(Date.now() + this.config.CAMPAIGN_MEDIA_UPLOAD_TTL_SECONDS * 1000),
      idempotencyKey,
    };
    // Expiry is server-owned and must not make an idempotent replay hash drift.
    const stableRequestHash = createHash('sha256').update(JSON.stringify({
      sessionId: input.sessionId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      sha256: input.sha256,
      chunkSize: input.chunkSize,
    })).digest('hex');
    const result = await this.repository.createUpload({
      ...input,
      requestHash: stableRequestHash,
      storageMaxBytes: this.config.CAMPAIGN_MEDIA_STORAGE_MAX_BYTES,
    });
    if (!result.sessionFound) {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_UPLOAD_NOT_FOUND',
        'Session is not synchronized');
    }
    if (result.quotaExceeded) {
      throw new MediaAssetError(HttpStatus.INSUFFICIENT_STORAGE, 'MEDIA_STORAGE_QUOTA_EXCEEDED',
        'Campaign media storage quota would be exceeded', {
          maximumBytes: this.config.CAMPAIGN_MEDIA_STORAGE_MAX_BYTES,
        });
    }
    if (result.idempotencyConflict) {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT',
        'Idempotency-Key was already used with different upload metadata');
    }
    return { upload: result.upload!, created: result.created };
  }

  async getUpload(id: string) {
    const upload = await this.repository.findUpload(id);
    if (!upload) this.notFound('MEDIA_UPLOAD_NOT_FOUND', 'Media upload not found');
    this.sessions.assertVisible(upload!.sessionId);
    return upload!;
  }

  async putChunk(uploadId: string, chunkIndex: number, encoded: string) {
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
      throw new MediaAssetError(HttpStatus.BAD_REQUEST, 'MEDIA_UPLOAD_CHUNK_INVALID',
        'Chunk index must be a non-negative integer');
    }
    const upload = await this.getUpload(uploadId);
    if (encoded.length > Math.ceil(CAMPAIGN_MEDIA_CHUNK_BYTES / 3) * 4 + 8) {
      throw new MediaAssetError(HttpStatus.PAYLOAD_TOO_LARGE, 'MEDIA_UPLOAD_CHUNK_INVALID',
        'Encoded media chunk exceeds the configured chunk size');
    }
    const content = Buffer.from(encoded, 'base64');
    if (!content.length || content.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
      throw new MediaAssetError(HttpStatus.BAD_REQUEST, 'MEDIA_UPLOAD_CHUNK_INVALID',
        'Chunk data is not canonical base64');
    }
    const result = await this.repository.putChunk({
      uploadId,
      chunkIndex,
      content,
      sha256: MediaAssetRepository.digest(content),
    });
    if (result === 'NOT_FOUND') this.notFound('MEDIA_UPLOAD_NOT_FOUND', 'Media upload not found');
    if (result === 'EXPIRED') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_EXPIRED', 'Media upload has expired');
    }
    if (result === 'STATE_CONFLICT') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_STATE_CONFLICT',
        `Media upload is ${upload.status.toLowerCase()}`);
    }
    if (result === 'INDEX_INVALID' || result === 'SIZE_INVALID') {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_UPLOAD_CHUNK_INVALID',
        result === 'INDEX_INVALID' ? 'Chunk index is outside this upload' : 'Chunk byte length is invalid');
    }
    if (result === 'CONFLICT') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_CHUNK_CONFLICT',
        'This chunk index already contains different bytes');
    }
    return { created: result === 'CREATED' };
  }

  async completeUpload(id: string) {
    const visible = await this.getUpload(id);
    const result = await this.repository.completeUpload(id, (upload, content) => {
      if (content.length !== upload.byteSize) {
        throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_UPLOAD_INCOMPLETE',
          'Uploaded media byte length does not match the declared size');
      }
      const digest = MediaAssetRepository.digest(content);
      if (digest !== upload.sha256) {
        throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_DIGEST_MISMATCH',
          'Uploaded media SHA-256 does not match the declared digest');
      }
      if (!this.signatureMatches(upload.kind, upload.mimeType, content)) {
        throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_SIGNATURE_MISMATCH',
          'Media bytes do not match the declared MIME type');
      }
    });
    if (result.status === 'NOT_FOUND') this.notFound('MEDIA_UPLOAD_NOT_FOUND', 'Media upload not found');
    if (result.status === 'EXPIRED') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_EXPIRED', 'Media upload has expired');
    }
    if (result.status === 'STATE_CONFLICT') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_STATE_CONFLICT',
        `Media upload is ${visible.status.toLowerCase()}`);
    }
    if (result.status === 'INCOMPLETE') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_INCOMPLETE',
        'All media chunks must be uploaded before completion');
    }
    if (!result.asset) this.notFound('MEDIA_ASSET_NOT_FOUND', 'Completed media asset not found');
    return { asset: result.asset!, created: result.status === 'COMPLETED' };
  }

  async cancelUpload(id: string): Promise<void> {
    const upload = await this.getUpload(id);
    const result = await this.repository.cancelUpload(id);
    if (result === 'NOT_FOUND') this.notFound('MEDIA_UPLOAD_NOT_FOUND', 'Media upload not found');
    if (result === 'COMPLETED') {
      throw new MediaAssetError(HttpStatus.CONFLICT, 'MEDIA_UPLOAD_STATE_CONFLICT',
        `Media upload is ${upload.status.toLowerCase()}`);
    }
  }

  async getAsset(id: string) {
    const asset = await this.repository.findAsset(id);
    if (!asset) this.notFound('MEDIA_ASSET_NOT_FOUND', 'Media asset not found');
    this.sessions.assertVisible(asset!.sessionId);
    return asset!;
  }

  async readContent(id: string): Promise<StoredMediaAsset> {
    const asset = await this.repository.readAsset(id);
    if (!asset) this.notFound('MEDIA_ASSET_NOT_FOUND', 'Media asset not found');
    this.sessions.assertVisible(asset!.sessionId);
    this.assertStoredDigest(asset!);
    return asset!;
  }

  async resolveForCampaign(id: string, sessionId: string, kind: MediaAssetKind) {
    const asset = await this.repository.findAsset(id);
    if (!asset) this.notFound('MEDIA_ASSET_NOT_FOUND', 'Media asset not found');
    if (asset!.sessionId !== sessionId) {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_ASSET_SESSION_MISMATCH',
        'Media asset belongs to a different session');
    }
    if (asset!.kind !== kind) {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_ASSET_KIND_MISMATCH',
        'Media asset kind does not match campaign content');
    }
    return asset!;
  }

  async readForSend(id: string, sessionId: string): Promise<StoredMediaAsset> {
    const asset = await this.repository.readAsset(id);
    if (!asset || asset.sessionId !== sessionId) {
      this.notFound('MEDIA_ASSET_NOT_FOUND', 'Media asset not found');
    }
    this.assertStoredDigest(asset!);
    return asset!;
  }

  async matchesSnapshot(content: CampaignContentDto, sessionId: string): Promise<boolean> {
    if (content.type === CampaignContentType.TEXT) return true;
    const asset = await this.repository.findAsset(content.mediaAssetId);
    return Boolean(asset
      && asset.sessionId === sessionId
      && asset.kind === MediaAssetKind.IMAGE
      && asset.filename === content.filename
      && asset.mimeType === content.mimeType
      && asset.byteSize === content.byteSize
      && asset.sha256 === content.sha256);
  }

  private assertPolicy(kind: MediaAssetKind, mimeType: string, byteSize: number): void {
    if (!(CAMPAIGN_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_TYPE_NOT_ALLOWED',
        'Media MIME type is not allowed for image assets', {
          kind,
          mimeType,
          allowed: CAMPAIGN_IMAGE_MIME_TYPES,
        });
    }
    const maximum = this.config.CAMPAIGN_MEDIA_IMAGE_MAX_BYTES;
    if (byteSize > maximum) {
      throw new MediaAssetError(HttpStatus.PAYLOAD_TOO_LARGE, 'MEDIA_SIZE_LIMIT_EXCEEDED',
        'Media exceeds the configured size limit', { kind, maximumBytes: maximum });
    }
  }

  private sanitizeFilename(value: string): string {
    const normalized = value.normalize('NFKC')
      .replace(/[\u0000-\u001f\u007f/\\]/gu, '_')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/gu, '_')
      .replace(/^\.+/u, '')
      .trim();
    if (!normalized) {
      throw new MediaAssetError(HttpStatus.BAD_REQUEST, 'MEDIA_TYPE_NOT_ALLOWED',
        'Media filename must contain visible characters');
    }
    return normalized.slice(0, 255);
  }

  private signatureMatches(kind: MediaAssetKind, mimeType: string, content: Buffer): boolean {
    if (kind !== 'IMAGE') return false;
    if (mimeType === 'image/jpeg') {
      return content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
    }
    if (mimeType === 'image/png') {
      return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    }
    if (mimeType === 'image/webp') {
      return content.subarray(0, 4).toString('ascii') === 'RIFF'
        && content.subarray(8, 12).toString('ascii') === 'WEBP';
    }
    return false;
  }

  private assertStoredDigest(asset: StoredMediaAsset): void {
    if (MediaAssetRepository.digest(asset.content) !== asset.sha256) {
      throw new MediaAssetError(HttpStatus.UNPROCESSABLE_ENTITY, 'MEDIA_DIGEST_MISMATCH',
        'Stored image no longer matches its verified digest');
    }
  }

  private notFound(code: 'MEDIA_UPLOAD_NOT_FOUND' | 'MEDIA_ASSET_NOT_FOUND', message: string): never {
    throw new MediaAssetError(HttpStatus.NOT_FOUND, code, message);
  }
}
