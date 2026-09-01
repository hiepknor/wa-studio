const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

async function request(baseUrl: string, runtimeKey: string, path: string, init: RequestInit) {
  return operatorJsonRequest<Record<string, unknown>>(
    runtimeApiRootFromOrigin(baseUrl),
    runtimeKey,
    path,
    init,
    numberSetting('CAMPAIGN_FIXTURE_REQUEST_TIMEOUT_MS', 30_000, 1_000, 120_000),
  );
}

function numberSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = required('CAMPAIGN_FIXTURE_RUNTIME_URL');
  const runtimeKey = required('CAMPAIGN_FIXTURE_RUNTIME_KEY');
  const sessionId = required('CAMPAIGN_FIXTURE_SESSION_ID');
  const idempotencyKey = required('CAMPAIGN_FIXTURE_IDEMPOTENCY_KEY');
  const groupIds = (process.env.CAMPAIGN_FIXTURE_GROUP_IDS ?? '')
    .split(',').map(value => value.trim()).filter(Boolean);
  const canonical = {
    sessionId,
    name: 'WA Studio campaign fixture',
    text: 'Safe staging preflight fixture. No run is created.',
    scheduleType: 'IMMEDIATE',
  };
  const campaign = await request(baseUrl, runtimeKey, '/campaigns', {
    method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(canonical),
  });
  const campaignId = String(campaign.id);
  await request(baseUrl, runtimeKey, `/campaigns/${campaignId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      name: canonical.name, text: canonical.text, scheduleType: 'IMMEDIATE', scheduledAt: null,
    }),
  });
  await request(baseUrl, runtimeKey, `/campaigns/${campaignId}/targets`, {
    method: 'PUT', body: JSON.stringify({ groupIds }),
  });
  process.stdout.write(`Reset reusable campaign fixture ${campaignId} with ${groupIds.length} targets\n`);
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
import { operatorJsonRequest, runtimeApiRootFromOrigin } from './lib/operator-http';
