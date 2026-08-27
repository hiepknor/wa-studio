import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: options.env ?? process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
  return (result.stdout ?? '').trim();
}

function docker(args, capture = false) {
  return run('docker', args, { capture });
}

async function waitForPostgres(container) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = spawnSync('docker', [
      'exec', container, 'pg_isready', '-U', 'postgres', '-d', 'event_inbox_e2e',
    ], { stdio: 'ignore' });
    if (result.status === 0) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for isolated Event Inbox PostgreSQL');
}

function runE2E(databaseUrl) {
  run('npm', ['exec', '--', 'tsx', 'scripts/test-event-inbox-e2e.ts'], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function main() {
  if (process.env.DATABASE_URL) {
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
    await waitForPostgres(container);
    const mapping = docker(['port', container, '5432/tcp'], true);
    const port = mapping.match(/:(\d+)$/u)?.[1];
    if (!port) throw new Error(`Could not parse PostgreSQL port mapping: ${mapping}`);
    runE2E(`postgresql://postgres:test@127.0.0.1:${port}/event_inbox_e2e`);
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
