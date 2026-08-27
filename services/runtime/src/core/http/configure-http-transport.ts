import type { Server } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

interface HttpTransportOptions {
  maximumJsonBodyBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
}

export function configureHttpTransport(
  app: NestExpressApplication,
  options: HttpTransportOptions,
): void {
  const express = app.getHttpAdapter().getInstance() as { disable(setting: string): void };
  express.disable('x-powered-by');
  app.use((_request: Request, response: Response, next: NextFunction) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('cross-origin-resource-policy', 'same-origin');
    response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    next();
  });
  app.useBodyParser('json', {
    limit: options.maximumJsonBodyBytes,
    strict: true,
  });

  const server = app.getHttpServer() as Server;
  server.requestTimeout = options.requestTimeoutMs;
  server.headersTimeout = options.headersTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
}
