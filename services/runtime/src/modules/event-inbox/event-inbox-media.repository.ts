import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import type { EventInboxMediaLeaseResponse } from '../../contracts/event-inbox';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import type { EventInboxDeviceAuthorization } from './event-inbox-device.repository';

export type EventInboxMediaMimeType = 'image/jpeg' | 'image/png' | 'image/webp';

export interface EventInboxMediaUpload {
  attemptId: string;
  sessionId: string;
  filename: string;
  mimeType: EventInboxMediaMimeType;
  sha256: string;
  expiresAt: Date;
  content: Buffer;
}

export interface EventInboxMediaDownload {
  filename: string;
  mimeType: EventInboxMediaMimeType;
  byteSize: number;
  sha256: string;
  expiresAt: Date;
  content: Buffer;
}

export type EventInboxMediaStoreResult =
  | { kind: 'stored'; value: EventInboxMediaLeaseResponse }
  | { kind: 'conflict' }
  | { kind: 'capacity' }
  | { kind: 'unauthorized' };

@Injectable()
export class EventInboxMediaRepository implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {
    this.pool = new Pool({
      connectionString: config.EVENT_INBOX_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  async store(
    device: EventInboxDeviceAuthorization,
    upload: EventInboxMediaUpload,
  ): Promise<EventInboxMediaStoreResult> {
    if (!device.sessionIds.includes(upload.sessionId)) return { kind: 'unauthorized' };
    const contentHash = Buffer.from(upload.sha256, 'hex');
    const token = this.downloadToken(device.deviceId, upload.attemptId, upload.sha256);
    const tokenHash = this.downloadTokenHash(token);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (!await this.ownsSession(client, device, upload.sessionId)) {
        await client.query('ROLLBACK');
        return { kind: 'unauthorized' };
      }
      const usage = await client.query<{ stored_bytes: string }>(
        `SELECT stored_bytes::text FROM event_inbox_media_usage WHERE singleton FOR UPDATE`,
      );
      const existingBlob = await client.query<{
        blob_id: string;
        mime_type: EventInboxMediaMimeType;
        byte_size: string;
      }>(
        `SELECT blob_id::text, mime_type, byte_size::text
         FROM event_inbox_media_blobs
         WHERE device_id = $1::uuid AND content_sha256 = $2`,
        [device.deviceId, contentHash],
      );
      let blobId = existingBlob.rows[0]?.blob_id;
      const duplicateBlob = Boolean(blobId);
      if (blobId) {
        const blob = existingBlob.rows[0]!;
        if (blob.mime_type !== upload.mimeType || Number(blob.byte_size) !== upload.content.length) {
          await client.query('ROLLBACK');
          return { kind: 'conflict' };
        }
      } else {
        const storedBytes = Number(usage.rows[0]?.stored_bytes ?? 0);
        if (storedBytes + upload.content.length > this.config.EVENT_INBOX_MEDIA_MAX_STORED_BYTES) {
          await client.query('ROLLBACK');
          return { kind: 'capacity' };
        }
        blobId = randomUUID();
        await client.query(
          `INSERT INTO event_inbox_media_blobs
             (blob_id, device_id, content_sha256, mime_type, byte_size, content)
           VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
          [blobId, device.deviceId, contentHash, upload.mimeType, upload.content.length, upload.content],
        );
      }

      const insertedLease = await client.query(
        `INSERT INTO event_inbox_media_leases
           (attempt_id, device_id, token_generation, session_id, blob_id,
            download_token_hash, filename, expires_at)
         VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5::uuid, $6, $7, $8)
         ON CONFLICT (attempt_id) DO NOTHING
         RETURNING attempt_id`,
        [
          upload.attemptId,
          device.deviceId,
          device.tokenGeneration,
          upload.sessionId,
          blobId,
          tokenHash,
          upload.filename,
          upload.expiresAt,
        ],
      );
      const duplicateLease = (insertedLease.rowCount ?? 0) === 0;
      if (duplicateLease && !await this.leaseMatches(client, device, upload, blobId, tokenHash)) {
        await client.query('ROLLBACK');
        return { kind: 'conflict' };
      }
      await client.query('COMMIT');
      return {
        kind: 'stored',
        value: {
          attemptId: upload.attemptId,
          sessionId: upload.sessionId,
          mediaUrl: new URL(
            `/api/v1/media/${upload.attemptId}/${token}`,
            this.config.EVENT_INBOX_PUBLIC_BASE_URL,
          ).toString(),
          filename: upload.filename,
          mimeType: upload.mimeType,
          byteSize: upload.content.length,
          sha256: upload.sha256,
          expiresAt: upload.expiresAt.toISOString(),
          duplicate: duplicateBlob && duplicateLease,
        },
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async download(
    attemptId: string,
    token: string,
    countAccess: boolean,
  ): Promise<EventInboxMediaDownload | null> {
    const result = await this.pool.query<{
      download_token_hash: Buffer;
      filename: string;
      mime_type: EventInboxMediaMimeType;
      byte_size: string;
      content_sha256: Buffer;
      expires_at: Date;
      content: Buffer;
    }>(
      `SELECT lease.download_token_hash, lease.filename, blob.mime_type,
         blob.byte_size::text, blob.content_sha256, lease.expires_at, blob.content
       FROM event_inbox_media_leases AS lease
       JOIN event_inbox_media_blobs AS blob ON blob.blob_id = lease.blob_id
       JOIN event_inbox_devices AS device
         ON device.device_id = lease.device_id
        AND device.token_generation = lease.token_generation
        AND device.revoked_at IS NULL
        AND device.token_expires_at > now()
       JOIN event_inbox_session_owners AS owner
         ON owner.session_id = lease.session_id
        AND owner.device_id = lease.device_id
        AND owner.token_generation = lease.token_generation
       WHERE lease.attempt_id = $1::uuid
         AND lease.expires_at > now()
         AND lease.access_count < $2`,
      [attemptId, this.config.EVENT_INBOX_MEDIA_MAX_DOWNLOADS_PER_LEASE],
    );
    const row = result.rows[0];
    if (!row || !secureBufferEqual(row.download_token_hash, this.downloadTokenHash(token))) return null;
    if (countAccess) {
      const access = await this.pool.query(
        `UPDATE event_inbox_media_leases
         SET access_count = access_count + 1, last_accessed_at = now()
         WHERE attempt_id = $1::uuid AND expires_at > now() AND access_count < $2`,
        [attemptId, this.config.EVENT_INBOX_MEDIA_MAX_DOWNLOADS_PER_LEASE],
      );
      if ((access.rowCount ?? 0) !== 1) return null;
    }
    return {
      filename: row.filename,
      mimeType: row.mime_type,
      byteSize: Number(row.byte_size),
      sha256: row.content_sha256.toString('hex'),
      expiresAt: row.expires_at,
      content: row.content,
    };
  }

  async removeExpired(limit: number): Promise<{ leases: number; blobs: number }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const leases = await client.query<{ blob_id: string }>(
        `DELETE FROM event_inbox_media_leases
         WHERE attempt_id IN (
           SELECT attempt_id FROM event_inbox_media_leases
           WHERE expires_at <= now()
           ORDER BY expires_at, attempt_id
           LIMIT $1
           FOR UPDATE SKIP LOCKED
         )
         RETURNING blob_id::text`,
        [limit],
      );
      const blobIds = [...new Set(leases.rows.map(row => row.blob_id))];
      const blobs = blobIds.length === 0 ? { rowCount: 0 } : await client.query(
        `DELETE FROM event_inbox_media_blobs AS blob
         WHERE blob.blob_id = ANY($1::uuid[])
           AND NOT EXISTS (
             SELECT 1 FROM event_inbox_media_leases AS lease WHERE lease.blob_id = blob.blob_id
           )`,
        [blobIds],
      );
      await client.query('COMMIT');
      return { leases: leases.rowCount ?? 0, blobs: blobs.rowCount ?? 0 };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }

  private downloadToken(deviceId: string, attemptId: string, sha256: string): string {
    return createHmac('sha256', this.config.EVENT_INBOX_MASTER_SECRET)
      .update('event-inbox:media-download:v1\0')
      .update(deviceId)
      .update('\0')
      .update(attemptId)
      .update('\0')
      .update(sha256)
      .digest('base64url');
  }

  private downloadTokenHash(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  private async ownsSession(
    client: PoolClient,
    device: EventInboxDeviceAuthorization,
    sessionId: string,
  ): Promise<boolean> {
    const result = await client.query(
      `SELECT 1
       FROM event_inbox_session_owners AS owner
       JOIN event_inbox_devices AS record
         ON record.device_id = owner.device_id
        AND record.token_generation = owner.token_generation
        AND record.revoked_at IS NULL
        AND record.token_expires_at > now()
       WHERE owner.session_id = $1::uuid
         AND owner.device_id = $2::uuid
         AND owner.token_generation = $3
       FOR SHARE OF owner, record`,
      [sessionId, device.deviceId, device.tokenGeneration],
    );
    return (result.rowCount ?? 0) === 1;
  }

  private async leaseMatches(
    client: PoolClient,
    device: EventInboxDeviceAuthorization,
    upload: EventInboxMediaUpload,
    blobId: string,
    tokenHash: Buffer,
  ): Promise<boolean> {
    const result = await client.query<{
      device_id: string;
      token_generation: string;
      session_id: string;
      blob_id: string;
      download_token_hash: Buffer;
      filename: string;
      expires_at: Date;
    }>(
      `SELECT device_id::text, token_generation::text, session_id::text, blob_id::text,
         download_token_hash, filename, expires_at
       FROM event_inbox_media_leases WHERE attempt_id = $1::uuid`,
      [upload.attemptId],
    );
    const lease = result.rows[0];
    return Boolean(lease
      && lease.device_id === device.deviceId
      && Number(lease.token_generation) === device.tokenGeneration
      && lease.session_id === upload.sessionId
      && lease.blob_id === blobId
      && lease.filename === upload.filename
      && lease.expires_at.getTime() === upload.expiresAt.getTime()
      && secureBufferEqual(lease.download_token_hash, tokenHash));
  }
}

function secureBufferEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
}
