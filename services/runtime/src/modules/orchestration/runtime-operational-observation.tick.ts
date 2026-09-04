import { Injectable, Logger } from '@nestjs/common';
import { RuntimeOperationalEvidenceService } from '../../core/observability/runtime-operational-evidence.service';

@Injectable()
export class RuntimeOperationalObservationTick {
  private readonly logger = new Logger(RuntimeOperationalObservationTick.name);

  constructor(private readonly releaseEvidence: RuntimeOperationalEvidenceService) {}

  async run(): Promise<void> {
    const result = await this.releaseEvidence.recordObservation();
    if (result.clean) {
      this.logger.debug({
        event: 'runtime.operational_observation.recorded',
        observedAt: result.observedAt,
      });
      return;
    }
    this.logger.warn({
      event: 'runtime.operational_observation.violation',
      observedAt: result.observedAt,
      violationCodes: result.violationCodes,
    });
  }
}
