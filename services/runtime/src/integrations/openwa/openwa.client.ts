import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { runtimeConfig, type RuntimeConfig } from '../../core/config/runtime-config';
import { RUNTIME_CONFIG } from '../../core/config/runtime-config.module';
import {
  readBoundedResponseJson,
  readBoundedResponseText,
} from '../../core/http/bounded-response';
import { OpenWACompatibilityService } from './openwa-compatibility.service';
import {
  parseOpenWARateLimitHints,
  type OpenWARateLimitHints,
} from './safety/openwa-rate-limit-hints';
import type { CommittedOpenWAMessagePermit } from './safety/openwa-safety.types';
import {
  OpenWASafetyBlockedError,
  OpenWASafetyDeferredError,
  type OpenWAOperationClass,
  type OpenWAOperationOutcome,
  type OpenWAOperationPermit,
} from './safety/openwa-safety.types';
import { OpenWASafetyGovernorService } from './safety/openwa-safety-governor.service';

export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'action_required'
  | 'failed';

const nonEmptyString = z.string().min(1);
const nullableString = z.string().nullable().optional();
const dateTimeString = z.string().refine(value => Number.isFinite(Date.parse(value)), 'invalid datetime');
const nullableDateTimeString = dateTimeString.nullable().optional();
const sessionStatusSchema = z.enum([
  'created', 'initializing', 'qr_ready', 'authenticating', 'ready',
  'disconnected', 'action_required', 'failed',
]);
const sessionSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  status: sessionStatusSchema,
  phone: nullableString,
  pushName: nullableString,
  connectedAt: nullableDateTimeString,
  lastActive: nullableDateTimeString,
  createdAt: dateTimeString,
  updatedAt: dateTimeString,
  lastError: nullableString,
  restriction: z.record(z.string(), z.unknown()).nullable().optional(),
  engineLoaded: z.boolean(),
});
export const pendingGroupName = 'Group subject pending sync';
const groupSummaryBaseSchema = z.object({
  id: nonEmptyString,
  name: z.string().optional(),
  participantsCount: z.number().int().nonnegative().optional(),
  isAdmin: z.boolean().optional(),
  linkedParentJID: nullableString,
});
const groupSummarySchema = groupSummaryBaseSchema.transform(summary => ({
  ...summary,
  name: summary.name?.trim() ? summary.name : pendingGroupName,
}));
const participantSchema = z.object({
  id: nonEmptyString,
  number: nonEmptyString,
  name: nullableString,
  isAdmin: z.boolean(),
  isSuperAdmin: z.boolean(),
});
const contactSchema = z.object({
  id: nonEmptyString,
  number: z.string(),
  name: z.string().nullish(),
  pushName: z.string().nullish(),
  isMyContact: z.boolean(),
  isBlocked: z.boolean(),
  profilePicUrl: z.string().nullish(),
});
const groupSchema = groupSummaryBaseSchema.extend({
  description: nullableString,
  owner: nullableString,
  createdAt: z.number().int().optional(),
  participants: z.array(participantSchema).max(100_000),
  isReadOnly: z.boolean().optional(),
  isAnnounce: z.boolean().optional(),
  announce: z.boolean().optional(),
  locked: z.boolean().optional(),
  ephemeralSeconds: z.number().int().nonnegative().optional(),
  memberAddMode: z.enum(['all', 'admins']).optional(),
}).superRefine((group, context) => {
  const participantIds = new Set<string>();
  for (const participant of group.participants) {
    if (participantIds.has(participant.id)) {
      context.addIssue({
        code: 'custom',
        path: ['participants'],
        message: 'duplicate participant id',
      });
      return;
    }
    participantIds.add(participant.id);
  }
}).transform(group => ({
  ...group,
  name: group.name?.trim() ? group.name : pendingGroupName,
}));
const webhookSchema = z.object({
  id: nonEmptyString,
  sessionId: nonEmptyString,
  url: z.url(),
  events: z.array(nonEmptyString),
  active: z.boolean(),
  retryCount: z.number().int().min(0).max(5),
});
const healthSchema = z.object({ status: nonEmptyString, timestamp: dateTimeString, version: nonEmptyString });
const sendMessageResultSchema = z.object({ messageId: nonEmptyString, timestamp: z.number().int().nonnegative() });
const maximumErrorResponseBytes = 64 * 1024;

interface OpenWARequestSafetyContext {
  sessionId?: string;
  operationClass: Exclude<OpenWAOperationClass, 'MESSAGE_SEND_TEXT' | 'MESSAGE_SEND_IMAGE'>;
  holderType: 'GATEWAY_SYNC' | 'GROUP_REFRESH' | 'CONTACT_SYNC' | 'WEBHOOK_RECONCILIATION' | 'PROBE';
}

export type OpenWASendTextResult = z.infer<typeof sendMessageResultSchema>;
export type OpenWASendImageResult = z.infer<typeof sendMessageResultSchema>;
export type OpenWASession = z.infer<typeof sessionSchema>;
export type OpenWAGroupSummary = z.infer<typeof groupSummarySchema>;
export type OpenWAGroupParticipant = z.infer<typeof participantSchema>;
export type OpenWAGroup = z.infer<typeof groupSchema>;
export type OpenWAContact = z.infer<typeof contactSchema>;
export type OpenWAWebhook = z.infer<typeof webhookSchema>;
export type OpenWAHealth = z.infer<typeof healthSchema>;
export interface OpenWAWebhookReconciliationResult {
  created: number;
  updated: number;
  deleted: number;
}

export class OpenWAHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: string,
    readonly retryAfterMs?: number,
    readonly rateLimitHints?: OpenWARateLimitHints,
  ) {
    super(`OpenWA returned HTTP ${status}`);
    this.name = 'OpenWAHttpError';
  }
}

export class OpenWAResponseValidationError extends Error {
  constructor(readonly operation: string, readonly issues: number) {
    super(`OpenWA returned an invalid ${operation} response (${issues} schema issues)`);
    this.name = 'OpenWAResponseValidationError';
  }
}

@Injectable()
export class OpenWAClient implements OnModuleDestroy {
  private readonly logger = new Logger(OpenWAClient.name);
  private readonly abort = new AbortController();
  private safetySequence = 0;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig = runtimeConfig(),
    @Optional() private readonly compatibility?: OpenWACompatibilityService,
    @Optional() private readonly safety?: OpenWASafetyGovernorService,
  ) {}

  onModuleDestroy(): void {
    this.abort.abort();
  }

  private async request<T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    init?: RequestInit,
    safetyContext?: OpenWARequestSafetyContext,
  ): Promise<T> {
    if (operation !== 'health' && this.compatibility) {
      await this.compatibility.requireCompatible();
    }
    const started = performance.now();
    const method = init?.method ?? 'GET';
    let safetyPermit: OpenWAOperationPermit | undefined;
    if (this.safety && safetyContext) {
      const decision = await this.safety.reserveOperation({
        ...safetyContext,
        holderId: `${operation}:${process.pid}:${++this.safetySequence}`,
      });
      if (decision.outcome === 'DEFERRED') {
        throw new OpenWASafetyDeferredError(decision.notBefore, decision.reason);
      }
      if (decision.outcome === 'BLOCKED') throw new OpenWASafetyBlockedError(decision.reason);
      safetyPermit = decision.permit;
    }
    const headers = new Headers(init?.headers);
    headers.set('accept', 'application/json');
    headers.set('x-api-key', this.config.OPENWA_API_KEY);
    const deadline = AbortSignal.any([
      this.abort.signal,
      AbortSignal.timeout(this.config.OPENWA_REQUEST_DEADLINE_MS),
    ]);
    try {
      const response = await fetch(new URL(path, this.config.OPENWA_BASE_URL), {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          deadline,
          AbortSignal.timeout(this.config.OPENWA_REQUEST_TIMEOUT_MS),
        ]),
        headers,
      });
      if (!response.ok) {
        const rateLimitHints = parseOpenWARateLimitHints(response.headers);
        throw new OpenWAHttpError(
          response.status,
          await readBoundedResponseText(response, maximumErrorResponseBytes),
          rateLimitHints.retryAfterMs,
          rateLimitHints,
        );
      }
      const parsed = schema.safeParse(
        response.status === 204
          ? undefined
          : await readBoundedResponseJson(response, this.config.OPENWA_RESPONSE_MAX_BYTES),
      );
      if (!parsed.success) throw new OpenWAResponseValidationError(operation, parsed.error.issues.length);
      if (safetyPermit) await this.recordSafetyOutcome(safetyPermit, { kind: 'SUCCESS' });
      this.logger.debug({
        event: 'openwa.request.completed', operation, method, statusCode: response.status,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        rateLimitRetries: 0,
        transientRetries: 0,
      });
      return parsed.data;
    } catch (error) {
      if (safetyPermit) await this.recordSafetyOutcome(safetyPermit, this.safetyOutcome(error));
      this.logger.error({
        event: 'openwa.request.failed', operation, method,
        statusCode: error instanceof OpenWAHttpError ? error.status : undefined,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  private async requestWhenSafetyReady<T>(
    operation: string,
    path: string,
    schema: z.ZodType<T>,
    safetyContext: OpenWARequestSafetyContext,
  ): Promise<T> {
    const deadlineAt = Date.now() + this.config.OPENWA_REQUEST_DEADLINE_MS;
    for (;;) {
      try {
        return await this.request(operation, path, schema, undefined, safetyContext);
      } catch (error) {
        if (!(error instanceof OpenWASafetyDeferredError)
          || error.notBefore.valueOf() > deadlineAt) throw error;
        await delay(Math.max(1, error.notBefore.valueOf() - Date.now()), undefined, {
          signal: this.abort.signal,
        });
      }
    }
  }

  private async withSafetyWorkflow<T>(
    operation: string,
    context: OpenWARequestSafetyContext & { upstreamCost: number },
    workflow: () => Promise<T>,
  ): Promise<T> {
    if (this.compatibility) await this.compatibility.requireCompatible();
    if (!this.safety) return workflow();
    const decision = await this.safety.reserveOperation({
      ...context,
      holderId: `${operation}:${process.pid}:${++this.safetySequence}`,
    });
    if (decision.outcome === 'DEFERRED') {
      throw new OpenWASafetyDeferredError(decision.notBefore, decision.reason);
    }
    if (decision.outcome === 'BLOCKED') throw new OpenWASafetyBlockedError(decision.reason);
    try {
      const result = await workflow();
      await this.recordSafetyOutcome(decision.permit, { kind: 'SUCCESS' });
      return result;
    } catch (error) {
      await this.recordSafetyOutcome(decision.permit, this.safetyOutcome(error));
      throw error;
    }
  }

  private safetyOutcome(error: unknown): OpenWAOperationOutcome {
    if (error instanceof OpenWAHttpError) {
      if (error.status === 429) return { kind: 'RATE_LIMITED', retryAfterMs: error.retryAfterMs };
      if (error.status === 401) return { kind: 'TRANSIENT_FAILURE' };
      if (error.status >= 500 || error.status === 408) return { kind: 'TRANSIENT_FAILURE' };
      return { kind: 'SAFE_REJECTION' };
    }
    return { kind: 'TRANSIENT_FAILURE' };
  }

  private async recordSafetyOutcome(
    permit: OpenWAOperationPermit,
    outcome: OpenWAOperationOutcome,
  ): Promise<void> {
    try {
      await this.safety?.recordOutcome(permit, outcome);
    } catch (error) {
      this.logger.error({
        event: 'openwa.safety.outcome_record_failed',
        operationClass: permit.operationClass,
        outcome: outcome.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  listSessions(): Promise<OpenWASession[]> {
    return this.request('list_sessions', '/api/sessions?limit=1000', z.array(sessionSchema).max(1000), undefined, {
      operationClass: 'SESSION_READ', holderType: 'GATEWAY_SYNC',
    });
  }

  async assertCompatibleRelease(): Promise<void> {
    if (this.compatibility) {
      await this.compatibility.requireCompatible({ force: true });
      return;
    }
    const health = await this.request('health', '/api/health', healthSchema, undefined, {
      operationClass: 'RECOVERY_PROBE', holderType: 'PROBE',
    });
    if (health.version !== this.config.OPENWA_RELEASE_TAG) {
      throw new Error(
        `OpenWA release mismatch: expected ${this.config.OPENWA_RELEASE_TAG}, received ${health.version}`,
      );
    }
  }

  getSession(sessionId: string): Promise<OpenWASession> {
    return this.request('get_session', `/api/sessions/${encodeURIComponent(sessionId)}`, sessionSchema, undefined, {
      sessionId, operationClass: 'SESSION_READ', holderType: 'GATEWAY_SYNC',
    });
  }

  async listGroups(sessionId: string): Promise<OpenWAGroupSummary[]> {
    const pageSize = 1000;
    const maxPages = 100;
    const groups: OpenWAGroupSummary[] = [];
    const groupIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const offset = pageNumber * pageSize;
      const page = await this.requestWhenSafetyReady(
        'list_groups_page',
        `/api/sessions/${encodeURIComponent(sessionId)}/groups?limit=${pageSize}&offset=${offset}`,
        z.array(groupSummarySchema).max(pageSize),
        {
          sessionId,
          operationClass: pageNumber === 0 ? 'GROUP_READ_BULK' : 'PAGINATED_READ_PAGE',
          holderType: 'GATEWAY_SYNC',
        }
      );
      for (const group of page) {
        if (groupIds.has(group.id)) {
          throw new OpenWAResponseValidationError('list_groups', 1);
        }
        groupIds.add(group.id);
      }
      groups.push(...page);
      if (page.length < pageSize) return groups;
    }
    throw new OpenWAResponseValidationError('list_groups', 1);
  }

  getGroup(sessionId: string, groupId: string): Promise<OpenWAGroup> {
    return this.request('get_group',
      `/api/sessions/${encodeURIComponent(sessionId)}/groups/${encodeURIComponent(groupId)}`,
      groupSchema,
      undefined,
      { sessionId, operationClass: 'GROUP_READ_TARGETED', holderType: 'GROUP_REFRESH' },
    );
  }

  async *listContactPages(sessionId: string): AsyncGenerator<OpenWAContact[]> {
    const pageSize = 1000;
    const maxPages = 100;
    const contactIds = new Set<string>();
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const offset = pageNumber * pageSize;
      const page = await this.requestWhenSafetyReady(
        'list_contacts_page',
        `/api/sessions/${encodeURIComponent(sessionId)}/contacts?limit=${pageSize}&offset=${offset}`,
        z.array(contactSchema).max(pageSize),
        {
          sessionId,
          operationClass: pageNumber === 0 ? 'CONTACT_READ' : 'PAGINATED_READ_PAGE',
          holderType: 'CONTACT_SYNC',
        },
      );
      for (const contact of page) {
        if (contactIds.has(contact.id)) throw new OpenWAResponseValidationError('list_contacts', 1);
        contactIds.add(contact.id);
      }
      if (page.length > 0) yield page;
      if (page.length < pageSize) return;
    }
    throw new OpenWAResponseValidationError('list_contacts', 1);
  }

  listWebhooks(sessionId: string): Promise<OpenWAWebhook[]> {
    return this.request(
      'list_webhooks',
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks`,
      z.array(webhookSchema).max(10_000),
      undefined,
      { sessionId, operationClass: 'WEBHOOK_CONTROL', holderType: 'WEBHOOK_RECONCILIATION' },
    );
  }

  registerWebhook(input: {
    sessionId: string;
    url: string;
    events: string[];
    secret: string;
    retryCount: number;
  }): Promise<OpenWAWebhook> {
    return this.request('register_webhook', `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`, webhookSchema, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input.url,
          events: input.events,
          secret: input.secret,
          retryCount: input.retryCount,
        }),
      },
      { sessionId: input.sessionId, operationClass: 'WEBHOOK_CONTROL', holderType: 'WEBHOOK_RECONCILIATION' });
  }

  updateWebhook(input: {
    sessionId: string;
    webhookId: string;
    url: string;
    events: string[];
    secret: string;
    active: boolean;
    retryCount: number;
  }): Promise<OpenWAWebhook> {
    return this.request(
      'update_webhook',
      `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks/${encodeURIComponent(input.webhookId)}`,
      webhookSchema,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: input.url,
          events: input.events,
          secret: input.secret,
          active: input.active,
          retryCount: input.retryCount,
        }),
      },
      {
        sessionId: input.sessionId,
        operationClass: 'WEBHOOK_CONTROL',
        holderType: 'WEBHOOK_RECONCILIATION',
      },
    );
  }

  deleteWebhook(sessionId: string, webhookId: string): Promise<void> {
    return this.request(
      'delete_webhook',
      `/api/sessions/${encodeURIComponent(sessionId)}/webhooks/${encodeURIComponent(webhookId)}`,
      z.undefined(),
      { method: 'DELETE' },
      { sessionId, operationClass: 'WEBHOOK_CONTROL', holderType: 'WEBHOOK_RECONCILIATION' },
    );
  }

  reconcileWebhookRegistration(input: {
    sessionId: string;
    url: string;
    events: string[];
    secret: string;
    retryCount: number;
  }): Promise<OpenWAWebhookReconciliationResult> {
    const maximumDuplicateDeletes = 4;
    const normalizedUrl = new URL(input.url).toString();
    return this.withSafetyWorkflow(
      'reconcile_webhook_registration',
      {
        sessionId: input.sessionId,
        operationClass: 'WEBHOOK_CONTROL',
        holderType: 'WEBHOOK_RECONCILIATION',
        upstreamCost: 2 + maximumDuplicateDeletes,
      },
      async () => {
        const registrations = await this.request(
          'list_webhooks',
          `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`,
          z.array(webhookSchema).max(10_000),
        );
        const managed = registrations
          .filter(registration => new URL(registration.url).toString() === normalizedUrl)
          .sort((left, right) => left.id.localeCompare(right.id));
        if (managed.length === 0) {
          await this.request(
            'register_webhook',
            `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks`,
            webhookSchema,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                url: normalizedUrl,
                events: input.events,
                secret: input.secret,
                retryCount: input.retryCount,
              }),
            },
          );
          return { created: 1, updated: 0, deleted: 0 };
        }
        const retained = managed[0]!;
        await this.request(
          'update_webhook',
          `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks/${encodeURIComponent(retained.id)}`,
          webhookSchema,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              url: normalizedUrl,
              events: input.events,
              secret: input.secret,
              active: true,
              retryCount: input.retryCount,
            }),
          },
        );
        const duplicates = managed.slice(1, maximumDuplicateDeletes + 1);
        for (const duplicate of duplicates) {
          await this.request(
            'delete_webhook',
            `/api/sessions/${encodeURIComponent(input.sessionId)}/webhooks/${encodeURIComponent(duplicate.id)}`,
            z.undefined(),
            { method: 'DELETE' },
          );
        }
        return { created: 0, updated: 1, deleted: duplicates.length };
      },
    );
  }

  async sendText(
    permit: CommittedOpenWAMessagePermit,
    sessionId: string,
    chatId: string,
    text: string,
  ): Promise<OpenWASendTextResult> {
    this.assertMessagePermit(permit, sessionId, 'MESSAGE_SEND_TEXT');
    return this.request('send_text', `/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, sendMessageResultSchema, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ chatId, text }),
    });
  }

  async sendImage(permit: CommittedOpenWAMessagePermit, input: {
    sessionId: string;
    chatId: string;
    base64: string;
    mimetype: string;
    caption: string;
  }): Promise<OpenWASendImageResult> {
    this.assertMessagePermit(permit, input.sessionId, 'MESSAGE_SEND_IMAGE');
    return this.request(
      'send_image',
      `/api/sessions/${encodeURIComponent(input.sessionId)}/messages/send-image`,
      sendMessageResultSchema,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chatId: input.chatId,
          base64: input.base64,
          mimetype: input.mimetype,
          ...(input.caption ? { caption: input.caption } : {}),
        }),
      },
    );
  }

  private assertMessagePermit(
    permit: CommittedOpenWAMessagePermit,
    sessionId: string,
    operationClass: 'MESSAGE_SEND_TEXT' | 'MESSAGE_SEND_IMAGE',
  ): void {
    if (permit.sessionId !== sessionId
      || permit.operationClass !== operationClass
      || !(permit.upstreamStartedAt instanceof Date)
      || permit.upstreamAttemptNumber < 1) {
      throw new Error('OpenWA message send requires a matching committed safety permit');
    }
  }
}
