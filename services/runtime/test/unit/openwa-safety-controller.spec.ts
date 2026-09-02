import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { OpenWASafetyController } from '../../src/modules/openwa-safety/openwa-safety.controller';

describe('OpenWASafetyController', () => {
  it('returns the documented 200 status for control mutations', () => {
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      OpenWASafetyController.prototype.workspaceControl,
    )).toBe(HttpStatus.OK);
    expect(Reflect.getMetadata(
      HTTP_CODE_METADATA,
      OpenWASafetyController.prototype.control,
    )).toBe(HttpStatus.OK);
  });
});
