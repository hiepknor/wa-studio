export const RUNTIME_SERVICE = 'wa-runtime' as const;
export const RUNTIME_VERSION = '0.1.0';
export const RUNTIME_CONTRACT_VERSION = 'v1' as const;

export interface RuntimeReleaseManifest {
  schemaVersion: 1;
  service: typeof RUNTIME_SERVICE;
  version: string;
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  profiles: readonly ['server', 'desktop-managed'];
  roles: readonly ['api', 'worker', 'scheduler', 'desktop', 'migrate'];
  databaseBackends: readonly ['postgres'];
  queueBackends: readonly ['redis', 'postgres'];
}

export function runtimeReleaseManifest(): RuntimeReleaseManifest {
  return {
    schemaVersion: 1,
    service: RUNTIME_SERVICE,
    version: RUNTIME_VERSION,
    contractVersion: RUNTIME_CONTRACT_VERSION,
    profiles: ['server', 'desktop-managed'],
    roles: ['api', 'worker', 'scheduler', 'desktop', 'migrate'],
    databaseBackends: ['postgres'],
    queueBackends: ['redis', 'postgres'],
  };
}
