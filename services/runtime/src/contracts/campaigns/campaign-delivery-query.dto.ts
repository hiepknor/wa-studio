import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../common/pagination.dto';
import { CampaignDeliveryStatus } from './campaign-delivery.dto';

const commaSeparatedValues = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  return value.split(',').map(item => item.trim()).filter(Boolean);
};

export class CampaignDeliveryQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Trimmed case-insensitive literal substring search on group snapshot name or group ID.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(200)
  query?: string;

  @ApiPropertyOptional({ enum: CampaignDeliveryStatus, isArray: true })
  @IsOptional()
  @Transform(commaSeparatedValues)
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(CampaignDeliveryStatus, { each: true })
  status?: CampaignDeliveryStatus[];
}
