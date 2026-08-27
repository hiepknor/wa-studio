import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { runtimeConfig, type RuntimeConfig } from '../config/runtime-config';
import { RUNTIME_CONFIG } from '../config/runtime-config.module';
import { secureStringEqual } from '../security/secure-string-equal';
import { RuntimeMetricsService } from './runtime-metrics.service';

const bearerToken = (authorization: string | undefined): string | undefined => {
  if (!authorization) return undefined;
  const match = /^Bearer ([^\s]+)$/iu.exec(authorization);
  return match?.[1];
};

@Injectable()
export class RuntimeMetricsTokenGuard implements CanActivate {
  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.RUNTIME_METRICS_TOKEN;
    if (!expected) throw new NotFoundException();
    const request = context.switchToHttp().getRequest<Request>();
    if (!secureStringEqual(bearerToken(request.header('authorization')), expected)) {
      throw new UnauthorizedException('Missing or invalid metrics bearer token');
    }
    return true;
  }
}

@ApiExcludeController()
@Controller('metrics')
export class RuntimeMetricsController {
  constructor(private readonly metrics: RuntimeMetricsService) {}

  @Public()
  @UseGuards(RuntimeMetricsTokenGuard)
  @Get()
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', this.metrics.contentType);
    return this.metrics.scrape();
  }
}
