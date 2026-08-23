import { z } from 'zod';

export const eventInboxEventSchema = z.object({
  idempotencyKey: z.string().min(1).max(512),
  receiptHandle: z.string().min(1).max(2048),
  rawBody: z.base64().max(400_000),
  signature: z.string().min(1).max(512),
});

export const eventInboxClaimResponseSchema = z.object({
  data: z.array(eventInboxEventSchema).max(100),
});

export const eventInboxClaimSchema = z.object({
  limit: z.number().int().min(1).max(100).default(100),
  waitSeconds: z.number().int().min(0).max(25).default(20),
});

export const eventInboxAckSchema = z.object({
  receiptHandles: z.array(z.string().min(1).max(2048)).min(1).max(100),
});

export const eventInboxNackSchema = z.object({
  items: z.array(z.object({
    receiptHandle: z.string().min(1).max(2048),
    disposition: z.enum(['retry', 'dead']),
    reason: z.string().trim().min(1).max(256).optional(),
  })).min(1).max(100),
});

export const eventInboxPairingRequestSchema = z.object({
  openwaBaseUrl: z.url().max(2048),
  openwaApiKey: z.string().min(1).max(4096),
  deviceId: z.uuid(),
});

export const eventInboxPairingResponseSchema = z.object({
  protocolVersion: z.literal(2),
  eventInboxBaseUrl: z.url(),
  callbackUrl: z.url(),
  deviceToken: z.string().min(32).max(4096),
  webhookSecret: z.string().min(32).max(4096),
  sessionIds: z.array(z.uuid()).min(1).max(1000),
});

export type EventInboxEvent = z.infer<typeof eventInboxEventSchema>;
export type EventInboxNack = z.infer<typeof eventInboxNackSchema>['items'][number];
