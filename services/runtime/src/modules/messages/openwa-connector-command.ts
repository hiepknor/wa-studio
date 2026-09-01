import { createHash } from 'node:crypto';
import {
  openWAConnectorCommandSchema,
  type OpenWAConnectorCommand,
} from '../../contracts/openwa-connector';

export interface EncodedOpenWAConnectorCommand {
  command: OpenWAConnectorCommand;
  body: Buffer;
  sha256: string;
}

export function encodeOpenWAConnectorCommand(input: unknown): EncodedOpenWAConnectorCommand {
  const command = openWAConnectorCommandSchema.parse(input);
  const body = Buffer.from(canonicalJson(command), 'utf8');
  return {
    command,
    body,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Connector command numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
  }
  throw new TypeError('Connector command contains an unsupported JSON value');
}
