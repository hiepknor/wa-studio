import type { PluginStorage } from './openwa';
import { AsyncMutex } from './mutex';

export interface ConnectorBinding {
  sessionId: string;
  connectorId: string;
  webhookId: string;
  generation: number;
  updatedAt: string;
}

interface BindingState {
  schemaVersion: 1;
  sessionId: string;
  bindings: ConnectorBinding[];
}

const storageKey = 'wa-studio:v1:control:bindings';
const maximumRetainedBindings = 32;

export class BindingStore {
  private readonly mutex = new AsyncMutex();
  private bindings: ConnectorBinding[] = [];

  constructor(
    private readonly storage: PluginStorage,
    private readonly sessionId: string,
    private readonly connectorId: string,
  ) {}

  async load(): Promise<void> {
    await this.mutex.run(async () => {
      const value = await this.storage.get<BindingState>(storageKey);
      if (!value || value.schemaVersion !== 1 || value.sessionId !== this.sessionId
        || !Array.isArray(value.bindings)) {
        this.bindings = [];
        return;
      }
      this.bindings = value.bindings.filter(binding => validBinding(
        binding,
        this.sessionId,
        this.connectorId,
      ))
        .sort((left, right) => left.generation - right.generation)
        .slice(-maximumRetainedBindings);
    });
  }

  current(): ConnectorBinding | null {
    return this.bindings.at(-1) ?? null;
  }

  find(generation: number): ConnectorBinding | null {
    return this.bindings.find(binding => binding.generation === generation) ?? null;
  }

  async apply(bindings: ConnectorBinding[]): Promise<boolean> {
    return this.mutex.run(async () => {
      const incoming = bindings.filter(binding => validBinding(
        binding,
        this.sessionId,
        this.connectorId,
      ));
      if (incoming.length === 0) return false;
      const byGeneration = new Map(this.bindings.map(binding => [binding.generation, binding]));
      for (const binding of incoming) {
        const existing = byGeneration.get(binding.generation);
        if (existing && (existing.connectorId !== binding.connectorId
          || existing.webhookId !== binding.webhookId)) {
          throw new Error('Event Inbox returned a conflicting retained binding generation');
        }
        byGeneration.set(binding.generation, binding);
      }
      const next = [...byGeneration.values()]
        .sort((left, right) => left.generation - right.generation)
        .slice(-maximumRetainedBindings);
      const changed = JSON.stringify(next) !== JSON.stringify(this.bindings);
      this.bindings = next;
      if (changed) {
        await this.storage.set<BindingState>(storageKey, {
          schemaVersion: 1,
          sessionId: this.sessionId,
          bindings: next,
        });
      }
      return changed;
    });
  }
}

function validBinding(
  value: unknown,
  sessionId: string,
  connectorId: string,
): value is ConnectorBinding {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.sessionId === sessionId
    && record.connectorId === connectorId
    && typeof record.webhookId === 'string'
    && record.webhookId.length >= 1
    && record.webhookId.length <= 512
    && Number.isSafeInteger(record.generation)
    && Number(record.generation) > 0
    && typeof record.updatedAt === 'string'
    && Number.isFinite(new Date(record.updatedAt).valueOf());
}
