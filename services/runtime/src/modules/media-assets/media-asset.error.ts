import { HttpException, HttpStatus } from '@nestjs/common';
import type { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';

export type MediaAssetErrorCode =
  | 'MEDIA_UPLOAD_IDEMPOTENCY_KEY_REQUIRED'
  | 'MEDIA_UPLOAD_IDEMPOTENCY_KEY_INVALID'
  | 'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT'
  | 'MEDIA_UPLOAD_NOT_FOUND'
  | 'MEDIA_UPLOAD_STATE_CONFLICT'
  | 'MEDIA_UPLOAD_EXPIRED'
  | 'MEDIA_UPLOAD_CHUNK_INVALID'
  | 'MEDIA_UPLOAD_CHUNK_CONFLICT'
  | 'MEDIA_UPLOAD_INCOMPLETE'
  | 'MEDIA_ASSET_NOT_FOUND'
  | 'MEDIA_ASSET_SESSION_MISMATCH'
  | 'MEDIA_ASSET_KIND_MISMATCH'
  | 'MEDIA_TYPE_NOT_ALLOWED'
  | 'MEDIA_SIZE_LIMIT_EXCEEDED'
  | 'MEDIA_STORAGE_QUOTA_EXCEEDED'
  | 'MEDIA_DIGEST_MISMATCH'
  | 'MEDIA_SIGNATURE_MISMATCH';

export class MediaAssetError extends HttpException {
  constructor(
    status: HttpStatus,
    code: MediaAssetErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    const body: RuntimeErrorDto = { code, message, ...(details ? { details } : {}) };
    super(body, status);
  }
}
