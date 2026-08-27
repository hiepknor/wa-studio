import {
  OPENWA_CONTRACT_SHA256,
  OPENWA_RELEASE_TAG,
} from '../../contracts/release/openwa-release.generated';

export const RUNTIME_SERVICE = 'wa-runtime' as const;
export const RUNTIME_VERSION = '0.1.0';
export const RUNTIME_CONTRACT_VERSION = 'v1' as const;

export interface RuntimeReleaseManifest {
  schemaVersion: 2;
  service: typeof RUNTIME_SERVICE;
  version: string;
  contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  openwaReleaseTag: typeof OPENWA_RELEASE_TAG;
  openwaContractSha256: typeof OPENWA_CONTRACT_SHA256;
  profiles: readonly ['server', 'desktop-managed'];
  roles: readonly ['api', 'worker', 'scheduler', 'desktop', 'migrate'];
  databaseBackends: readonly ['postgres'];
  queueBackends: readonly ['redis', 'postgres'];
}

export function runtimeReleaseManifest(): RuntimeReleaseManifest {
  return {
    schemaVersion: 2,
    service: RUNTIME_SERVICE,
    version: RUNTIME_VERSION,
    contractVersion: RUNTIME_CONTRACT_VERSION,
    openwaReleaseTag: OPENWA_RELEASE_TAG,
    openwaContractSha256: OPENWA_CONTRACT_SHA256,
    profiles: ['server', 'desktop-managed'],
    roles: ['api', 'worker', 'scheduler', 'desktop', 'migrate'],
    databaseBackends: ['postgres'],
    queueBackends: ['redis', 'postgres'],
  };
}
