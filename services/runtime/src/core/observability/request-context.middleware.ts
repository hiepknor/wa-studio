import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { withCorrelationContext } from './correlation-context';
import { RuntimeMetricsService } from './runtime-metrics.service';

const requestId = (value: string | string[] | undefined): string => {
  const supplied = Array.isArray(value) ? value[0] : value;
  return supplied && /^[A-Za-z0-9._-]{1,100}$/.test(supplied) ? supplied : randomUUID();
};

export const httpRouteLabel = (request: Pick<Request, 'baseUrl' | 'route'>): string => {
  const route = request.route as { path?: unknown } | undefined;
  if (typeof route?.path !== 'string' || route.path.length === 0 || route.path.length > 240) {
    return '<unmatched>';
  }
  const combined = `${request.baseUrl ?? ''}${route.path}`.replace(/\/{2,}/gu, '/');
  return combined.startsWith('/') ? combined : `/${combined}`;
};

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  constructor(private readonly metrics: RuntimeMetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const id = requestId(request.headers['x-request-id']);
    response.setHeader('x-request-id', id);
    withCorrelationContext({ requestId: id }, () => {
      const started = performance.now();
      const metric = this.metrics.startHttpRequest(request.method);
      let written = false;
      const writeCompletion = (outcome: 'finished' | 'closed') => {
        if (written) return;
        written = true;
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        const route = httpRouteLabel(request);
        metric.finish({
          durationMs,
          outcome,
          route,
          statusCode: response.statusCode,
        });
        this.logger.log({
          event: 'http.request.completed',
          method: request.method,
          path: route,
          statusCode: response.statusCode,
          outcome,
          durationMs,
        });
      };
      response.once('finish', () => writeCompletion('finished'));
      response.once('close', () => writeCompletion('closed'));
      next();
    });
  }
}
