import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import {
  StateRevisionsDto,
  StateRevisionsQueryDto,
} from '../../contracts/state-revisions/state-revisions.dto';
import { StateRevisionsService } from './state-revisions.service';

@ApiTags('state-revisions')
@ApiSecurity('runtime-key')
@Controller('state-revisions')
export class StateRevisionsController {
  constructor(private readonly revisions: StateRevisionsService) {}

  @Get()
  @ApiOperation({ summary: 'Read the current revision vector for filterable Runtime resources' })
  @ApiOkResponse({ type: StateRevisionsDto })
  read(@Query() query: StateRevisionsQueryDto) {
    return this.revisions.read(query.sessionId);
  }
}
