import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  OpenWASafetyControlDto,
  OpenWASafetyProfileChangeDto,
  OpenWASafetyScopeDto,
} from '../../contracts/safety/openwa-safety.dto';
import { OpenWASafetyService } from './openwa-safety.service';

@ApiTags('openwa-safety')
@ApiSecurity('runtime-key')
@Controller('openwa-safety')
export class OpenWASafetyController {
  constructor(private readonly safety: OpenWASafetyService) {}

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Read the durable OpenWA safety state for one session' })
  @ApiOkResponse({ type: OpenWASafetyScopeDto })
  snapshot(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.safety.snapshot(sessionId);
  }

  @Post('sessions/:sessionId/control')
  @ApiOperation({ summary: 'Manually block or resume OpenWA operations for one session' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: OpenWASafetyScopeDto })
  control(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: OpenWASafetyControlDto,
  ) {
    return this.safety.mutateControl(sessionId, idempotencyKey, input);
  }

  @Put('sessions/:sessionId/profile')
  @ApiOperation({ summary: 'Change the enforced OpenWA safety profile for one session' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: OpenWASafetyScopeDto })
  profile(
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: OpenWASafetyProfileChangeDto,
  ) {
    return this.safety.mutateProfile(sessionId, idempotencyKey, input);
  }
}
