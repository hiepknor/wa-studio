import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { MediaAssetDto, MediaAssetKind, MediaUploadDto } from '../../contracts/media-assets/media-asset.dto';
import { DatabaseService } from '../../core/database/database.service';

interface MediaAssetMetadataRow {
  id: string;
  session_id: string;
  kind: MediaAssetKind;
  filename: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
  created_at: Date;
}
interface MediaAssetRow extends MediaAssetMetadataRow { content: Buffer; }

interface MediaUploadRow {
  id: string;
  session_id: string;
  kind: MediaAssetKind;
  filename: string;
  declared_mime_type: string;
  byte_size: number;
  sha256: string;
  chunk_size: number;
  status: 'UPLOADING' | 'COMPLETED' | 'CANCELLED';
  create_request_hash: string;
  completed_asset_id: string | null;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  uploaded_chunks: number[] | null;
}

export interface StoredMediaAsset extends MediaAssetDto {
  content: Buffer;
}

const uploadSelect = `
  SELECT mu.*,
    COALESCE((
      SELECT array_agg(muc.chunk_index ORDER BY muc.chunk_index)
      FROM media_upload_chunks muc WHERE muc.upload_id = mu.id
    ), ARRAY[]::integer[]) AS uploaded_chunks
  FROM media_uploads mu`;

const mediaAssetMetadataSelect = `
  SELECT id, session_id, kind, filename, mime_type, byte_size, sha256, created_at
  FROM media_assets`;

const mapAsset = (row: MediaAssetMetadataRow): MediaAssetDto => ({
  id: row.id,
  sessionId: row.session_id,
  kind: row.kind,
  filename: row.filename,
  mimeType: row.mime_type,
  byteSize: Number(row.byte_size),
  sha256: row.sha256,
  createdAt: row.created_at,
});

const mapUpload = (row: MediaUploadRow): MediaUploadDto => ({
  id: row.id,
  sessionId: row.session_id,
  kind: row.kind,
  filename: row.filename,
  mimeType: row.declared_mime_type,
  byteSize: Number(row.byte_size),
  sha256: row.sha256,
  chunkSize: Number(row.chunk_size),
  totalChunks: Math.ceil(Number(row.byte_size) / Number(row.chunk_size)),
  uploadedChunks: row.uploaded_chunks ?? [],
  status: row.status,
  completedAssetId: row.completed_asset_id,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

@Injectable()
export class MediaAssetRepository {
  constructor(private readonly database: DatabaseService) {}

  async createUpload(input: {
    sessionId: string;
    kind: MediaAssetKind;
    filename: string;
    mimeType: string;
    byteSize: number;
    sha256: string;
    chunkSize: number;
    expiresAt: Date;
    idempotencyKey: string;
    requestHash: string;
    storageMaxBytes: number;
  }): Promise<{
    upload: MediaUploadDto | null;
    created: boolean;
    sessionFound: boolean;
    idempotencyConflict: boolean;
    quotaExceeded: boolean;
  }> {
    return this.database.transaction(async client => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('campaign-media-storage'))`);
      const existing = await client.query<MediaUploadRow>(
        `${uploadSelect} WHERE mu.create_idempotency_key = $1::uuid FOR UPDATE OF mu`,
        [input.idempotencyKey],
      );
      if (existing.rows[0]) {
        return {
          upload: mapUpload(existing.rows[0]),
          created: false,
          sessionFound: true,
          idempotencyConflict: existing.rows[0].create_request_hash !== input.requestHash,
          quotaExceeded: false,
        };
      }

      const session = await client.query('SELECT 1 FROM gateway_sessions WHERE id = $1 FOR SHARE', [input.sessionId]);
      if (session.rowCount !== 1) {
        return {
          upload: null, created: false, sessionFound: false,
          idempotencyConflict: false, quotaExceeded: false,
        };
      }
      const usage = await client.query<{ bytes: string }>(
        `SELECT (
           COALESCE((SELECT sum(byte_size) FROM media_assets), 0)
           + COALESCE((SELECT sum(byte_size) FROM media_uploads
             WHERE status = 'UPLOADING' AND expires_at > now()), 0)
         )::text AS bytes`,
      );
      if (Number(usage.rows[0]?.bytes ?? 0) + input.byteSize > input.storageMaxBytes) {
        return {
          upload: null, created: false, sessionFound: true,
          idempotencyConflict: false, quotaExceeded: true,
        };
      }

      const inserted = await client.query<MediaUploadRow>(
        `INSERT INTO media_uploads
           (session_id, kind, filename, declared_mime_type, byte_size, sha256, chunk_size,
            create_idempotency_key, create_request_hash, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid,$9,$10)
         RETURNING *, ARRAY[]::integer[] AS uploaded_chunks`,
        [input.sessionId, input.kind, input.filename, input.mimeType, input.byteSize, input.sha256,
          input.chunkSize, input.idempotencyKey, input.requestHash, input.expiresAt],
      );
      return {
        upload: mapUpload(inserted.rows[0]!), created: true, sessionFound: true,
        idempotencyConflict: false, quotaExceeded: false,
      };
    });
  }

  async findUpload(id: string): Promise<MediaUploadDto | null> {
    const result = await this.database.query<MediaUploadRow>(`${uploadSelect} WHERE mu.id = $1`, [id]);
    return result.rows[0] ? mapUpload(result.rows[0]) : null;
  }

  async putChunk(input: {
    uploadId: string;
    chunkIndex: number;
    content: Buffer;
    sha256: string;
  }): Promise<'CREATED' | 'REPLAY' | 'NOT_FOUND' | 'EXPIRED' | 'STATE_CONFLICT' | 'INDEX_INVALID' | 'SIZE_INVALID' | 'CONFLICT'> {
    return this.database.transaction(async client => {
      const result = await client.query<MediaUploadRow>(
        'SELECT *, ARRAY[]::integer[] AS uploaded_chunks FROM media_uploads WHERE id = $1 FOR UPDATE',
        [input.uploadId],
      );
      const upload = result.rows[0];
      if (!upload) return 'NOT_FOUND';
      if (upload.status !== 'UPLOADING') return 'STATE_CONFLICT';
      if (upload.expires_at <= new Date()) return 'EXPIRED';
      const totalChunks = Math.ceil(Number(upload.byte_size) / Number(upload.chunk_size));
      if (input.chunkIndex < 0 || input.chunkIndex >= totalChunks) return 'INDEX_INVALID';
      const expectedBytes = input.chunkIndex === totalChunks - 1
        ? Number(upload.byte_size) - input.chunkIndex * Number(upload.chunk_size)
        : Number(upload.chunk_size);
      if (input.content.length !== expectedBytes) return 'SIZE_INVALID';

      const existing = await client.query<{ sha256: string; byte_size: number }>(
        'SELECT sha256, byte_size FROM media_upload_chunks WHERE upload_id = $1 AND chunk_index = $2',
        [input.uploadId, input.chunkIndex],
      );
      if (existing.rows[0]) {
        return existing.rows[0].sha256 === input.sha256
          && Number(existing.rows[0].byte_size) === input.content.length
          ? 'REPLAY' : 'CONFLICT';
      }
      await client.query(
        `INSERT INTO media_upload_chunks (upload_id, chunk_index, byte_size, sha256, content)
         VALUES ($1,$2,$3,$4,$5)`,
        [input.uploadId, input.chunkIndex, input.content.length, input.sha256, input.content],
      );
      await client.query('UPDATE media_uploads SET updated_at = now() WHERE id = $1', [input.uploadId]);
      return 'CREATED';
    });
  }

  async completeUpload(
    uploadId: string,
    validate: (upload: MediaUploadDto, content: Buffer) => void,
  ): Promise<{
    asset: MediaAssetDto | null;
    status: 'COMPLETED' | 'REPLAY' | 'NOT_FOUND' | 'EXPIRED' | 'STATE_CONFLICT' | 'INCOMPLETE';
  }> {
    return this.database.transaction(async client => {
      const result = await client.query<MediaUploadRow>(
        `${uploadSelect} WHERE mu.id = $1 FOR UPDATE OF mu`,
        [uploadId],
      );
      const row = result.rows[0];
      if (!row) return { asset: null, status: 'NOT_FOUND' };
      const upload = mapUpload(row);
      if (upload.status === 'COMPLETED' && upload.completedAssetId) {
        const asset = await this.findAssetWithClient(client, upload.completedAssetId);
        return { asset: asset ? mapAsset(asset) : null, status: 'REPLAY' };
      }
      if (upload.status !== 'UPLOADING') return { asset: null, status: 'STATE_CONFLICT' };
      if (upload.expiresAt <= new Date()) return { asset: null, status: 'EXPIRED' };
      if (upload.uploadedChunks.length !== upload.totalChunks
        || upload.uploadedChunks.some((index, position) => index !== position)) {
        return { asset: null, status: 'INCOMPLETE' };
      }
      const chunks = await client.query<{ content: Buffer }>(
        'SELECT content FROM media_upload_chunks WHERE upload_id = $1 ORDER BY chunk_index',
        [uploadId],
      );
      const content = Buffer.concat(chunks.rows.map(chunk => chunk.content));
      validate(upload, content);
      const inserted = await client.query<MediaAssetRow>(
        `INSERT INTO media_assets (session_id, kind, filename, mime_type, byte_size, sha256, content)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [upload.sessionId, upload.kind, upload.filename, upload.mimeType,
          upload.byteSize, upload.sha256, content],
      );
      const asset = inserted.rows[0]!;
      await client.query(
        `UPDATE media_uploads SET status = 'COMPLETED', completed_asset_id = $2,
           updated_at = now() WHERE id = $1`,
        [uploadId, asset.id],
      );
      await client.query('DELETE FROM media_upload_chunks WHERE upload_id = $1', [uploadId]);
      return { asset: mapAsset(asset), status: 'COMPLETED' };
    });
  }

  async cancelUpload(id: string): Promise<'CANCELLED' | 'REPLAY' | 'NOT_FOUND' | 'COMPLETED'> {
    return this.database.transaction(async client => {
      const result = await client.query<{ status: 'UPLOADING' | 'COMPLETED' | 'CANCELLED' }>(
        'SELECT status FROM media_uploads WHERE id = $1 FOR UPDATE', [id],
      );
      const row = result.rows[0];
      if (!row) return 'NOT_FOUND';
      if (row.status === 'COMPLETED') return 'COMPLETED';
      if (row.status === 'CANCELLED') return 'REPLAY';
      await client.query(
        `UPDATE media_uploads SET status = 'CANCELLED', updated_at = now() WHERE id = $1`, [id],
      );
      await client.query('DELETE FROM media_upload_chunks WHERE upload_id = $1', [id]);
      return 'CANCELLED';
    });
  }

  async findAsset(id: string): Promise<MediaAssetDto | null> {
    const result = await this.database.query<MediaAssetMetadataRow>(
      `${mediaAssetMetadataSelect} WHERE id = $1`, [id],
    );
    return result.rows[0] ? mapAsset(result.rows[0]) : null;
  }

  async readAsset(id: string): Promise<StoredMediaAsset | null> {
    const result = await this.database.query<MediaAssetRow>('SELECT * FROM media_assets WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? { ...mapAsset(row), content: row.content } : null;
  }

  private async findAssetWithClient(client: PoolClient, id: string): Promise<MediaAssetMetadataRow | null> {
    const result = await client.query<MediaAssetMetadataRow>(`${mediaAssetMetadataSelect} WHERE id = $1`, [id]);
    return result.rows[0] ?? null;
  }

  static digest(content: Buffer): string {
    return createHash('sha256').update(content).digest('hex');
  }
}
