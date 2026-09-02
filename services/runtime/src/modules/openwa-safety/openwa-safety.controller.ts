import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  OpenWASafetyControlDto,
  OpenWASafetyProfileChangeDto,
  OpenWASafetyQuiescenceDto,
  OpenWASafetyScopeDto,
} from '../../contracts/safety/openwa-safety.dto';
import { OpenWASafetyService } from './openwa-safety.service';

@ApiTags('openwa-safety')
@ApiSecurity('runtime-key')
@Controller('openwa-safety')
export class OpenWASafetyController {
  constructor(private readonly safety: OpenWASafetyService) {}

  @Get('workspace/quiescence')
  @ApiOperation({ summary: 'Check whether the managed workspace has drained all in-flight OpenWA work' })
  @ApiOkResponse({ type: OpenWASafetyQuiescenceDto })
  workspaceQuiescence() {
    return this.safety.workspaceQuiescence();
  }

  @Post('workspace/control')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block or resume every OpenWA operation in the managed workspace' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ type: OpenWASafetyScopeDto })
  workspaceControl(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() input: OpenWASafetyControlDto,
  ) {
    return this.safety.mutateWorkspaceControl(idempotencyKey, input);
  }

  @Get('sessions/:sessionId')
  @ApiOperation({ summary: 'Read the durable OpenWA safety state for one session' })
  @ApiOkResponse({ type: OpenWASafetyScopeDto })
  snapshot(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.safety.snapshot(sessionId);
  }

  @Get('sessions/:sessionId/quiescence')
  @ApiOperation({ summary: 'Check whether one session has drained all in-flight OpenWA work' })
  @ApiOkResponse({ type: OpenWASafetyQuiescenceDto })
  quiescence(@Param('sessionId', ParseUUIDPipe) sessionId: string) {
    return this.safety.quiescence(sessionId);
  }

  @Post('sessions/:sessionId/control')
  @HttpCode(HttpStatus.OK)
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
