import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenWA compatibility manifest', () => {
  it('pins the repository OpenWA release and the connector protocol', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'manifest.json'), 'utf8'));
    const components = JSON.parse(readFileSync(resolve(process.cwd(), '../../release/components.json'), 'utf8'));
    expect(manifest).toMatchObject({
      id: 'wa-studio-connector',
      type: 'extension',
      sdkVersion: '1',
      minOpenWAVersion: components.openwaReleaseTag,
      testedOpenWAVersion: components.openwaReleaseTag,
      waStudioProtocolVersion: 1,
      waStudioJournalSchemaVersion: 1,
    });
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      'webhook:ingress', 'conversation:send', 'net:fetch', 'storage:use',
    ]));
  });
});
