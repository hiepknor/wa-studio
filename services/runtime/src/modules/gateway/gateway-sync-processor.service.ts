import { Injectable } from '@nestjs/common';
import type { FullGatewaySyncPayload, GroupReconciliationPayload, TargetedGroupReconciliationPayload } from './gateway-sync.types';
import { GatewaySyncService } from './gateway-sync.service';

@Injectable()
export class GatewaySyncProcessorService {
  constructor(private readonly sync: GatewaySyncService) {}

  process(name: string, payload: FullGatewaySyncPayload | GroupReconciliationPayload | TargetedGroupReconciliationPayload): Promise<unknown> {
    if (name === 'reconcile-session-group') {
      return this.sync.reconcileGroup((payload as GroupReconciliationPayload).itemId);
    }
    if (name === 'reconcile-targeted-group') {
      const targeted = payload as TargetedGroupReconciliationPayload;
      return this.sync.reconcileTargetedGroup(targeted.sessionId, targeted.groupId);
    }
    const full = payload as FullGatewaySyncPayload;
    return this.sync.perform(full.syncRunId);
  }
}
