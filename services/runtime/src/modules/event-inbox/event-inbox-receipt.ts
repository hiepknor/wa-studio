import { z } from 'zod';

const receiptSchema = z.object({
  idempotencyKey: z.string().min(1).max(512),
  leaseId: z.uuid(),
});

export type EventInboxReceipt = z.infer<typeof receiptSchema>;

export function encodeEventInboxReceipt(receipt: EventInboxReceipt): string {
  return Buffer.from(JSON.stringify(receipt), 'utf8').toString('base64url');
}

export function decodeEventInboxReceipt(value: string): EventInboxReceipt | null {
  try {
    const parsed = receiptSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
