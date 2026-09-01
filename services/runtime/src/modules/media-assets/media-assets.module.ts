import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { MediaAssetController } from './media-asset.controller';
import { MediaAssetRepository } from './media-asset.repository';
import { MediaAssetService } from './media-asset.service';
import { MediaSendBudgetService } from './media-send-budget.service';

@Module({
  imports: [GatewayModule],
  controllers: [MediaAssetController],
  providers: [MediaAssetRepository, MediaAssetService, MediaSendBudgetService],
  exports: [MediaAssetRepository, MediaAssetService, MediaSendBudgetService],
})
export class MediaAssetsModule {}
