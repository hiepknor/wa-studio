import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiSecurity,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { RuntimeErrorDto } from '../../contracts/common/runtime-error.dto';
import {
  CreateMediaUploadDto,
  MediaAssetDto,
  MediaAssetPolicyDto,
  MediaUploadDto,
  PutMediaUploadChunkDto,
} from '../../contracts/media-assets/media-asset.dto';
import { MediaAssetService } from './media-asset.service';

@ApiTags('media-assets')
@ApiSecurity('runtime-key')
@ApiBadRequestResponse({ type: RuntimeErrorDto })
@ApiNotFoundResponse({ type: RuntimeErrorDto })
@ApiConflictResponse({ type: RuntimeErrorDto })
@ApiUnprocessableEntityResponse({ type: RuntimeErrorDto })
@ApiResponse({ status: 413, type: RuntimeErrorDto, description: 'Image or chunk exceeds the V1 size limit' })
@ApiResponse({ status: 507, type: RuntimeErrorDto, description: 'Campaign image storage quota exceeded' })
@Controller('media-assets')
export class MediaAssetController {
  constructor(private readonly media: MediaAssetService) {}

  @Get('policy')
  @ApiOperation({ summary: 'Read Campaign image upload policy' })
  @ApiOkResponse({ type: MediaAssetPolicyDto })
  policy() { return this.media.policy(); }

  @Post('uploads')
  @ApiOperation({ summary: 'Create an idempotent Campaign image upload' })
  @ApiHeader({ name: 'Idempotency-Key', required: true, schema: { type: 'string', format: 'uuid' } })
  @ApiCreatedResponse({ type: MediaUploadDto })
  @ApiOkResponse({ type: MediaUploadDto, description: 'Idempotent replay' })
  async createUpload(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateMediaUploadDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.media.createUpload(dto, idempotencyKey);
    response.status(result.created ? 201 : 200);
    return result.upload;
  }

  @Get('uploads/:id')
  @ApiOperation({ summary: 'Read resumable Campaign image upload state' })
  @ApiOkResponse({ type: MediaUploadDto })
  getUpload(@Param('id', ParseUUIDPipe) id: string) { return this.media.getUpload(id); }

  @Put('uploads/:id/chunks/:index')
  @ApiOperation({ summary: 'Store one idempotent Campaign image upload chunk' })
  @ApiCreatedResponse()
  @ApiOkResponse({ description: 'Idempotent chunk replay' })
  async putChunk(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: PutMediaUploadChunkDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.media.putChunk(id, index, dto.data);
    response.status(result.created ? 201 : 200);
    return { accepted: true };
  }

  @Post('uploads/:id/complete')
  @ApiOperation({ summary: 'Verify and complete a Campaign image upload' })
  @ApiCreatedResponse({ type: MediaAssetDto })
  @ApiOkResponse({ type: MediaAssetDto, description: 'Idempotent completion replay' })
  async completeUpload(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.media.completeUpload(id);
    response.status(result.created ? 201 : 200);
    return result.asset;
  }

  @Delete('uploads/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an incomplete Campaign image upload' })
  @ApiNoContentResponse()
  async cancelUpload(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.media.cancelUpload(id);
  }

  @Get(':id/content')
  @ApiOperation({ summary: 'Read verified Campaign image content' })
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  @ApiOkResponse({ schema: { type: 'string', format: 'binary' } })
  async readContent(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const asset = await this.media.readContent(id);
    response.set({
      'Cache-Control': 'private, max-age=31536000, immutable',
      'Content-Length': String(asset.content.byteLength),
      'Content-Type': asset.mimeType,
      ETag: `"sha256-${asset.sha256}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(asset.content);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read Campaign image asset metadata' })
  @ApiOkResponse({ type: MediaAssetDto })
  getAsset(@Param('id', ParseUUIDPipe) id: string) { return this.media.getAsset(id); }
}
