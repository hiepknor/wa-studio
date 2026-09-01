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
import { EVENT_INBOX_CONFIG } from '../../core/event-inbox/event-inbox-config.module';
import { eventInboxConfig, type EventInboxConfig } from '../../core/event-inbox/event-inbox-config';
import { secureStringEqual } from '../../core/security/secure-string-equal';
import { EventInboxMetricsService } from './event-inbox-metrics.service';

const bearerToken = (authorization: string | undefined): string | undefined =>
  /^Bearer ([^\s]+)$/iu.exec(authorization ?? '')?.[1];

@Injectable()
export class EventInboxMetricsTokenGuard implements CanActivate {
  constructor(
    @Inject(EVENT_INBOX_CONFIG) private readonly config: EventInboxConfig = eventInboxConfig(),
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.EVENT_INBOX_METRICS_TOKEN;
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
export class EventInboxMetricsController {
  constructor(private readonly metrics: EventInboxMetricsService) {}

  @UseGuards(EventInboxMetricsTokenGuard)
  @Get()
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', this.metrics.contentType);
    return this.metrics.scrape();
  }
}
