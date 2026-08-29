import {
  Body, Controller, Get, Headers, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse, ApiBody, ApiExtraModels, ApiHeader, ApiOkResponse, ApiOperation,
  ApiResponse, ApiSecurity, ApiTags, getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { SessionDto, SessionListDto } from '../../contracts/sessions/session.dto';
import { SyncRunDto } from '../../contracts/sessions/sync-run.dto';
import { SyncRequestDto } from '../../contracts/sessions/sync-request.dto';
import { SyncModeConflictDto } from '../../contracts/sessions/sync-mode-conflict.dto';
import { GatewayRepository } from './gateway.repository';
import { GatewaySyncService } from './gateway-sync.service';
import { SessionService } from './session.service';
import { SessionScopeService } from './session-scope.service';

@ApiTags('sessions')
@ApiSecurity('runtime-key')
@ApiExtraModels(RuntimeErrorDto, SyncModeConflictDto)
@Controller('sessions')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly sync: GatewaySyncService,
    private readonly repository: GatewayRepository,
    private readonly sessionScope: SessionScopeService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List allowlisted Gateway sessions' })
  @ApiOkResponse({ type: SessionListDto })
  list() { return this.sessions.list(); }

  @Get(':id')
  @ApiOperation({ summary: 'Read a Gateway session from the durable read model' })
  @ApiOkResponse({ type: SessionDto })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.sessions.get(id); }

  @Post(':id/sync')
  @HttpCode(202)
  @ApiOperation({ summary: 'Queue durable discovery and group reconciliation' })
  @ApiBody({ type: SyncRequestDto, required: false })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiAcceptedResponse({ type: SyncRunDto })
  @ApiResponse({ status: 200, type: SyncRunDto, description: 'Idempotent replay' })
  @ApiResponse({
    status: 409,
    description: 'The operation key conflicts or another sync mode is active',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(RuntimeErrorDto) },
        { $ref: getSchemaPath(SyncModeConflictDto) },
      ],
    },
  })
  async requestSync(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: SyncRequestDto = new SyncRequestDto(),
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.sync.request(id, idempotencyKey, request.mode);
    response.status(result.replayed ? 200 : 202);
    return result.run;
  }

  @Get(':id/sync-runs/:runId')
  @ApiOperation({ summary: 'Read sync progress' })
  @ApiOkResponse({ type: SyncRunDto })
  async getSyncRun(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('runId', ParseUUIDPipe) runId: string,
  ) {
    this.sessionScope.assertVisible(id);
    const run = await this.repository.findSyncRun(runId);
    if (!run || run.sessionId !== id) throw new NotFoundException('Sync run not found');
    return run;
  }
}
