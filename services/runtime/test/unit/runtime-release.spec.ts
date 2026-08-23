import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeReleaseManifest, RUNTIME_VERSION } from '../../src/core/release/runtime-release';
import { parseRuntimeCommand } from '../../src/entrypoints/runtime';

describe('runtime release manifest', () => {
  it('stays aligned with the package version and declares desktop support honestly', () => {
    const packageJson = JSON.parse(readFileSync(
      resolve(process.cwd(), 'package.json'),
      'utf8',
    )) as { version: string };

    expect(RUNTIME_VERSION).toBe(packageJson.version);
    expect(runtimeReleaseManifest()).toEqual({
      schemaVersion: 1,
      service: 'wa-runtime',
      version: packageJson.version,
      contractVersion: 'v1',
      profiles: ['server', 'desktop-managed'],
      roles: ['api', 'worker', 'scheduler', 'migrate'],
      databaseBackends: ['postgres'],
      queueBackends: ['redis', 'postgres'],
    });
  });
});

describe('unified Runtime command', () => {
  it.each(['api', 'worker', 'scheduler', 'migrate', 'manifest'] as const)(
    'accepts the %s role',
    command => expect(parseRuntimeCommand(command)).toBe(command),
  );

  it.each([undefined, '', 'unknown'])('rejects missing or unsupported role %s', command => {
    expect(() => parseRuntimeCommand(command)).toThrow(
      'Usage: wa-runtime <api|worker|scheduler|migrate|manifest>',
    );
  });
});
