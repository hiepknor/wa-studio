import { Inject, Injectable } from '@nestjs/common';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';

interface Waiter {
  bytes: number;
  reject: (error: unknown) => void;
  resolve: (release: () => void) => void;
}

interface MediaSendBudgetWaitOptions {
  onWait?: () => Promise<void>;
  waitHeartbeatMs?: number;
}

// One live image send retains the Postgres Buffer while creating a base64 string and
// a serialized JSON request body. Four times the raw size is a conservative process-local weight.
export const campaignImageSendMemoryWeight = (rawBytes: number): number => rawBytes * 4;

@Injectable()
export class MediaSendBudgetService {
  private activeBytes = 0;
  private readonly waiters: Waiter[] = [];

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
  ) {}

  async withBytes<T>(
    bytes: number,
    operation: () => Promise<T>,
    options: MediaSendBudgetWaitOptions = {},
  ): Promise<T> {
    const reservation = this.acquire(bytes);
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (options.onWait) {
      let heartbeatInFlight = false;
      heartbeat = setInterval(() => {
        if (heartbeatInFlight) return;
        heartbeatInFlight = true;
        options.onWait!()
          .catch(error => reservation.cancel(error))
          .finally(() => { heartbeatInFlight = false; });
      }, options.waitHeartbeatMs ?? 30_000);
      heartbeat.unref();
    }
    let release: () => void;
    try {
      release = await reservation.promise;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private acquire(bytes: number): {
    promise: Promise<() => void>;
    cancel: (error: unknown) => void;
  } {
    if (!Number.isSafeInteger(bytes) || bytes <= 0
      || bytes > this.config.CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES) {
      throw new Error('Campaign media exceeds the per-process send memory budget');
    }
    let waiter: Waiter;
    const promise = new Promise<() => void>((resolve, reject) => {
      waiter = { bytes, reject, resolve };
      this.waiters.push(waiter);
      this.drain();
    });
    return {
      promise,
      cancel: error => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        waiter.reject(error);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.waiters.length) {
      const next = this.waiters[0]!;
      if (this.activeBytes + next.bytes > this.config.CAMPAIGN_MEDIA_SEND_MEMORY_BUDGET_BYTES) return;
      this.waiters.shift();
      this.activeBytes += next.bytes;
      let released = false;
      next.resolve(() => {
        if (released) return;
        released = true;
        this.activeBytes -= next.bytes;
        this.drain();
      });
    }
  }
}
