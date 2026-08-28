import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum MediaAssetKind {
  IMAGE = 'IMAGE',
}

export class CreateMediaUploadDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sessionId!: string;

  @ApiProperty({ enum: MediaAssetKind })
  @IsEnum(MediaAssetKind)
  kind!: MediaAssetKind;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename!: string;

  @ApiProperty({ maxLength: 127 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(127)
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: 8_388_608 })
  @IsInt()
  @Min(1)
  @Max(8_388_608)
  byteSize!: number;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  @IsString()
  @Matches(/^[0-9a-f]{64}$/u)
  sha256!: string;
}

export class PutMediaUploadChunkDto {
  @ApiProperty({ description: 'Base64-encoded raw chunk bytes.' })
  @IsString()
  @IsBase64()
  data!: string;
}

export class MediaUploadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ enum: MediaAssetKind }) kind!: MediaAssetKind;
  @ApiProperty() filename!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty() sha256!: string;
  @ApiProperty() chunkSize!: number;
  @ApiProperty() totalChunks!: number;
  @ApiProperty({ type: [Number] }) uploadedChunks!: number[];
  @ApiProperty({ enum: ['UPLOADING', 'COMPLETED', 'CANCELLED'] })
  status!: 'UPLOADING' | 'COMPLETED' | 'CANCELLED';
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  completedAssetId!: string | null;
  @ApiProperty({ format: 'date-time' }) expiresAt!: Date;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
  @ApiProperty({ format: 'date-time' }) updatedAt!: Date;
}

export class MediaAssetDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
  @ApiProperty({ enum: MediaAssetKind }) kind!: MediaAssetKind;
  @ApiProperty() filename!: string;
  @ApiProperty() mimeType!: string;
  @ApiProperty() byteSize!: number;
  @ApiProperty() sha256!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: Date;
}

export class MediaAssetPolicyDto {
  @ApiProperty({ enum: [393_216] }) chunkSize!: number;
  @ApiProperty({ type: [String] }) imageMimeTypes!: string[];
  @ApiProperty() imageMaxBytes!: number;
  @ApiProperty() storageMaxBytes!: number;
}
