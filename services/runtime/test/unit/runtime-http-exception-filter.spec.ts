import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  runtimeErrorFromException,
  runtimeErrorFromHttpException,
} from '../../src/core/http/runtime-http-exception.filter';

describe('Runtime HTTP exception normalization', () => {
  it('preserves feature-owned machine-readable errors', () => {
    const body = {
      code: 'CAMPAIGN_NOT_EDITABLE',
      message: 'Only DRAFT campaigns can be edited',
      details: { status: 'ACTIVE' },
    };

    expect(runtimeErrorFromHttpException(new ConflictException(body))).toBe(body);
  });

  it.each([
    [new ForbiddenException('Session is outside the allowlist'), 'FORBIDDEN'],
    [new NotFoundException('Resource not found'), 'RESOURCE_NOT_FOUND'],
    [new ConflictException('State changed'), 'CONFLICT'],
  ])('maps generic HTTP failures to stable Runtime codes', (exception, code) => {
    expect(runtimeErrorFromHttpException(exception)).toEqual({
      code,
      message: exception.message,
      details: {},
    });
  });

  it('groups class-validator messages by field', () => {
    const exception = new BadRequestException([
      'limit must not be greater than 200',
      'property unexpected should not exist',
    ]);

    expect(runtimeErrorFromHttpException(exception)).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'limit must not be greater than 200',
      fieldErrors: {
        limit: ['limit must not be greater than 200'],
        unexpected: ['property unexpected should not exist'],
      },
      details: {},
    });
  });

  it('does not expose unexpected exception details', () => {
    expect(runtimeErrorFromException(new Error('database password leaked'))).toEqual({
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'Internal server error', details: {} },
    });
  });

  it('normalizes Express parser failures without exposing body content', () => {
    const tooLarge = Object.assign(new Error('entity too large: secret body'), {
      type: 'entity.too.large', status: 413,
    });
    expect(runtimeErrorFromException(tooLarge)).toEqual({
      status: 413,
      body: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit',
        details: {},
      },
    });

    const invalid = Object.assign(new SyntaxError('Unexpected token secret'), {
      type: 'entity.parse.failed', status: 400,
    });
    expect(runtimeErrorFromException(invalid)).toEqual({
      status: 400,
      body: {
        code: 'VALIDATION_ERROR',
        message: 'Request body is not valid JSON',
        fieldErrors: { request: ['Request body is not valid JSON'] },
        details: {},
      },
    });
  });
});
