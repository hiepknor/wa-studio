import {
  Body,
  ConflictException,
  Controller,
  Get,
  Head,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  PayloadTooLargeException,
  Put,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Response } from 'express';
import { z } from 'zod';
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { EventInboxTokenService } from '../../core/event-inbox/event-inbox-token.service';
import { EventInboxDeviceRepository } from './event-inbox-device.repository';
import {
  EventInboxMediaRepository,
  type EventInboxMediaDownload,
  type EventInboxMediaMimeType,
} from './event-inbox-media.repository';

const uuidSchema = z.uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const mimeTypes = new Set<EventInboxMediaMimeType>(['image/jpeg', 'image/png', 'image/webp']);

@Controller('event-inbox/media')
export class EventInboxMediaUploadController {
  constructor(
    private readonly repository: EventInboxMediaRepository,
    private readonly tokens: EventInboxTokenService,
    private readonly devices: EventInboxDeviceRepository,
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  @Put(':attemptId')
  @HttpCode(200)
  async upload(
    @Param('attemptId') attemptIdValue: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-wa-session-id') sessionIdValue: string | undefined,
    @Headers('x-wa-content-sha256') sha256Value: string | undefined,
    @Headers('x-wa-filename-b64') filenameValue: string | undefined,
    @Headers('x-wa-expires-at') expiresAtValue: string | undefined,
    @Headers('content-type') contentTypeValue: string | undefined,
    @Body() body: unknown,
  ) {
    const claims = this.tokens.authenticate(authorization);
    const device = await this.devices.authorize(claims);
    if (!device) throw new UnauthorizedException('Invalid Event Inbox device token');
    const attemptId = uuidSchema.safeParse(attemptIdValue);
    const sessionId = uuidSchema.safeParse(sessionIdValue);
    const sha256 = sha256Schema.safeParse(sha256Value);
    const filename = decodeFilename(filenameValue);
    const expiresAt = parseExpiry(expiresAtValue, this.config.EVENT_INBOX_MEDIA_MAX_LEASE_SECONDS);
    const mimeType = normalizedMimeType(contentTypeValue);
    if (!attemptId.success || !sessionId.success || !sha256.success || !filename || !expiresAt) {
      throw new UnprocessableEntityException('Invalid Event Inbox media lease metadata');
    }
    if (!mimeType) throw new UnsupportedMediaTypeException('Unsupported connector image media type');
    if (!Buffer.isBuffer(body)) {
      throw new UnsupportedMediaTypeException('Connector image upload requires a binary image body');
    }
    if (body.length === 0) throw new UnprocessableEntityException('Connector image body is empty');
    if (body.length > this.config.EVENT_INBOX_MEDIA_MAX_BYTES) {
      throw new PayloadTooLargeException('Connector image exceeds the Event Inbox media limit');
    }
    if (detectMimeType(body) !== mimeType) {
      throw new UnprocessableEntityException('Connector image bytes do not match the declared media type');
    }
    if (createHash('sha256').update(body).digest('hex') !== sha256.data) {
      throw new UnprocessableEntityException('Connector image digest does not match the uploaded bytes');
    }
    const result = await this.repository.store(device, {
      attemptId: attemptId.data,
      sessionId: sessionId.data,
      filename,
      mimeType,
      sha256: sha256.data,
      expiresAt,
      content: body,
    });
    if (result.kind === 'unauthorized') {
      throw new UnauthorizedException('Session is not owned by this Event Inbox device');
    }
    if (result.kind === 'conflict') {
      throw new ConflictException('Media attempt identity conflicts with an existing immutable lease');
    }
    if (result.kind === 'capacity') {
      throw new ServiceUnavailableException('Event Inbox media relay capacity is exhausted');
    }
    return result.value;
  }
}

@Controller('media')
export class EventInboxMediaDownloadController {
  constructor(private readonly repository: EventInboxMediaRepository) {}

  @Get(':attemptId/:token')
  async get(
    @Param('attemptId') attemptId: string,
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.serve(attemptId, token, response, true);
  }

  @Head(':attemptId/:token')
  async head(
    @Param('attemptId') attemptId: string,
    @Param('token') token: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.serve(attemptId, token, response, false);
  }

  private async serve(
    attemptIdValue: string,
    tokenValue: string,
    response: Response,
    includeBody: boolean,
  ): Promise<void> {
    const attemptId = uuidSchema.safeParse(attemptIdValue);
    const token = tokenSchema.safeParse(tokenValue);
    if (!attemptId.success || !token.success) throw new NotFoundException();
    const media = await this.repository.download(attemptId.data, token.data, includeBody);
    if (!media) throw new NotFoundException();
    setDownloadHeaders(response, media);
    if (includeBody) response.status(200).send(media.content);
    else response.status(200).end();
  }
}

function normalizedMimeType(value: string | undefined): EventInboxMediaMimeType | null {
  const normalized = value?.split(';', 1)[0]?.trim().toLowerCase() as EventInboxMediaMimeType | undefined;
  return normalized && mimeTypes.has(normalized) ? normalized : null;
}

function detectMimeType(content: Buffer): EventInboxMediaMimeType | null {
  if (content.length >= 3 && content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
    return 'image/jpeg';
  }
  if (content.length >= 8 && content.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  )) return 'image/png';
  if (content.length >= 12
    && content.subarray(0, 4).toString('ascii') === 'RIFF'
    && content.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function decodeFilename(value: string | undefined): string | null {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) return null;
    const filename = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (filename.length === 0 || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(filename)) {
      return null;
    }
    return filename;
  } catch {
    return null;
  }
}

function parseExpiry(value: string | undefined, maximumLeaseSeconds: number): Date | null {
  if (!value) return null;
  const expiresAt = new Date(value);
  const now = Date.now();
  if (!Number.isFinite(expiresAt.getTime())
    || expiresAt.getTime() < now + 30_000
    || expiresAt.getTime() > now + maximumLeaseSeconds * 1_000) return null;
  return expiresAt;
}

function setDownloadHeaders(response: Response, media: EventInboxMediaDownload): void {
  response.setHeader('cache-control', 'private, no-store, max-age=0');
  response.setHeader('content-type', media.mimeType);
  response.setHeader('content-length', String(media.byteSize));
  response.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(media.filename)}`);
  response.setHeader('etag', `"sha256-${media.sha256}"`);
  response.setHeader('x-wa-content-sha256', media.sha256);
  response.setHeader('expires', media.expiresAt.toUTCString());
  response.setHeader('accept-ranges', 'none');
}
