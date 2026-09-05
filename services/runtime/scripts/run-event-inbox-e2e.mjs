import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture && result.stderr?.trim()
      ? `\n${result.stderr.trim()}`
      : '';
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}${detail}`);
  }
  return (result.stdout ?? '').trim();
}

function docker(args, capture = false) {
  return run('docker', args, { capture });
}

async function waitForPostgres(databaseUrl) {
  const deadline = Date.now() + 60_000;
  let consecutiveReadyChecks = 0;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 2_000 });
    try {
      await client.connect();
      await client.query('SELECT 1');
      consecutiveReadyChecks += 1;
      if (consecutiveReadyChecks >= 3) return;
    } catch {
      consecutiveReadyChecks = 0;
    } finally {
      await client.end().catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for stable Event Inbox PostgreSQL readiness');
}

function runE2E(databaseUrl) {
  run('npm', ['exec', '--', 'tsx', 'scripts/test-event-inbox-e2e.ts'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function main() {
  if (process.env.DATABASE_URL) {
    await waitForPostgres(process.env.DATABASE_URL);
    runE2E(process.env.DATABASE_URL);
    return;
  }

  docker(['info'], true);
  const container = `wa-event-inbox-e2e-postgres-${randomUUID().slice(0, 8)}`;
  let started = false;
  try {
    docker([
      'run', '--rm', '-d', '--name', container,
      '-e', 'POSTGRES_PASSWORD=test',
      '-e', 'POSTGRES_DB=event_inbox_e2e',
      '-p', '127.0.0.1::5432',
      'postgres:17-alpine',
    ], true);
    started = true;
    const mapping = docker(['port', container, '5432/tcp'], true);
    const port = mapping.match(/:(\d+)$/u)?.[1];
    if (!port) throw new Error(`Could not parse PostgreSQL port mapping: ${mapping}`);
    const databaseUrl = `postgresql://postgres:test@127.0.0.1:${port}/event_inbox_e2e`;
    await waitForPostgres(databaseUrl);
    runE2E(databaseUrl);
  } finally {
    if (started) {
      const stopped = spawnSync('docker', ['stop', container], { stdio: 'ignore' });
      if (stopped.status !== 0) {
        process.stderr.write(`Could not stop isolated Event Inbox PostgreSQL ${container}.\n`);
      }
    }
  }
}

await main();
