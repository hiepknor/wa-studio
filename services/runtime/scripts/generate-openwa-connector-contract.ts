import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  OPENWA_CONNECTOR_PROTOCOL_VERSION,
  openWAConnectorCommandSchema,
  openWAConnectorEvidenceSchema,
} from '../src/contracts/openwa-connector';

export interface GeneratedConnectorContract {
  filename: string;
  contents: string;
}

const document = (
  id: string,
  title: string,
  schema: z.ZodType,
): Record<string, unknown> => ({
  $id: `https://wa-studio.local/contracts/openwa-connector/v${OPENWA_CONNECTOR_PROTOCOL_VERSION}/${id}`,
  title,
  ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' }),
});

export const renderOpenWAConnectorContract = (): GeneratedConnectorContract[] => [
  {
    filename: 'command.schema.json',
    contents: `${JSON.stringify(document(
      'command.schema.json',
      'WA Studio OpenWA connector command v1',
      openWAConnectorCommandSchema,
    ), null, 2)}\n`,
  },
  {
    filename: 'evidence.schema.json',
    contents: `${JSON.stringify(document(
      'evidence.schema.json',
      'WA Studio OpenWA connector evidence v1',
      openWAConnectorEvidenceSchema,
    ), null, 2)}\n`,
  },
];

export const generateOpenWAConnectorContract = (outputDirectory = resolve(
  process.cwd(),
  '..',
  '..',
  'packages',
  'runtime-contract',
  'openwa-connector',
  `v${OPENWA_CONNECTOR_PROTOCOL_VERSION}`,
)): void => {
  mkdirSync(outputDirectory, { recursive: true });
  for (const file of renderOpenWAConnectorContract()) {
    writeFileSync(resolve(outputDirectory, file.filename), file.contents);
  }
};

if (require.main === module) generateOpenWAConnectorContract();
