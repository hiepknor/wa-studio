import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseFilters } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiConflictResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation,
  ApiQuery, ApiSecurity, ApiTags,
} from '@nestjs/swagger';
import { CampaignDeliveryListDto } from '../../contracts/campaigns/campaign-delivery.dto';
import { CampaignDeliveryQueryDto } from '../../contracts/campaigns/campaign-delivery-query.dto';
import { CampaignRunDto, CampaignRunSummaryListDto } from '../../contracts/campaigns/campaign-run.dto';
import { CampaignRunQueryDto } from '../../contracts/campaigns/campaign-run-query.dto';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import { CampaignHttpExceptionFilter } from './campaign-http-exception.filter';
import { CampaignRunService } from './campaign-run.service';

@ApiTags('campaign-runs')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@ApiConflictResponse({ type: RuntimeErrorDto })
@UseFilters(CampaignHttpExceptionFilter)
@Controller('campaign-runs')
export class CampaignRunController {
  constructor(private readonly runs: CampaignRunService) {}

  @Get()
  @ApiQuery({ name: 'status', required: false, isArray: true, style: 'form', explode: false })
  @ApiQuery({ name: 'executionMode', required: false, isArray: true, style: 'form', explode: false })
  @ApiOperation({ summary: 'Search and filter durable campaign runs in one allowlisted session' })
  @ApiOkResponse({ type: CampaignRunSummaryListDto })
  list(@Query() query: CampaignRunQueryDto) { return this.runs.listWorkspace(query); }

  @Get(':id')
  @ApiOperation({ summary: 'Read a durable campaign run' })
  @ApiOkResponse({ type: CampaignRunDto })
  get(@Param('id', ParseUUIDPipe) id: string) { return this.runs.get(id); }

  @Get(':id/deliveries')
  @ApiOperation({ summary: 'List per-group deliveries for a campaign run' })
  @ApiOkResponse({ type: CampaignDeliveryListDto })
  @ApiQuery({ name: 'status', required: false, isArray: true, style: 'form', explode: false })
  deliveries(@Param('id', ParseUUIDPipe) id: string, @Query() query: CampaignDeliveryQueryDto) {
    return this.runs.deliveries(id, query);
  }

  @Post(':id/pause')
  @ApiOperation({ summary: 'Pause new delivery materialization for a campaign run' })
  @ApiOkResponse({ type: CampaignRunDto })
  pause(@Param('id', ParseUUIDPipe) id: string) { return this.runs.pause(id); }

  @Post(':id/resume')
  @ApiOperation({ summary: 'Re-run preflight and resume a paused or blocked campaign run' })
  @ApiOkResponse({ type: CampaignRunDto })
  resume(@Param('id', ParseUUIDPipe) id: string) { return this.runs.resume(id); }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancel pending work for a campaign run' })
  @ApiOkResponse({ type: CampaignRunDto })
  cancel(@Param('id', ParseUUIDPipe) id: string) { return this.runs.cancel(id); }
}
