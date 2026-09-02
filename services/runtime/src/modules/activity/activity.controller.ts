import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { ActivityEventDto, ActivityPageDto } from '../../contracts/activity/activity.dto';
import { ActivityIdentityQueryDto, ActivityQueryDto } from '../../contracts/activity/activity-query.dto';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { ActivityService } from './activity.service';

@ApiTags('activity')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@Controller('activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  @ApiQuery({ name: 'category', required: false, isArray: true, style: 'form', explode: false })
  @ApiQuery({ name: 'severity', required: false, isArray: true, style: 'form', explode: false })
  @ApiOperation({ summary: 'Read the retained operational activity timeline for one allowlisted session' })
  @ApiOkResponse({ type: ActivityPageDto })
  list(@Query() query: ActivityQueryDto) { return this.activity.list(query); }

  @Get(':id')
  @ApiOperation({ summary: 'Read one retained operational activity event in an allowlisted session' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ActivityEventDto })
  get(@Param('id', new ParseUUIDPipe()) id: string, @Query() query: ActivityIdentityQueryDto) {
    return this.activity.get(query.sessionId, id);
  }
}
