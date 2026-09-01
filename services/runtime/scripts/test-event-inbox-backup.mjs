import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const runtimeRoot = process.cwd();
const backupScript = resolve(runtimeRoot, 'deploy/event-inbox/event-inbox-backup.sh');
const restoreScript = resolve(runtimeRoot, 'deploy/event-inbox/event-inbox-restore-drill.sh');
const root = mkdtempSync(resolve(tmpdir(), 'wa-event-inbox-backup-test-'));

try {
  const fakeBin = resolve(root, 'bin');
  const deploy = resolve(root, 'deploy');
  const remote = resolve(root, 'remote');
  const staging = resolve(root, 'staging');
  const work = resolve(root, 'work');
  const metrics = resolve(root, 'metrics');
  const createdMarker = resolve(root, 'created-database');
  const droppedMarker = resolve(root, 'dropped-database');
  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(deploy, { recursive: true });
  mkdirSync(remote, { recursive: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(deploy, 'compose.yaml'), 'services: {}\n');
  writeFileSync(resolve(deploy, 'event-inbox.env'), 'POSTGRES_DB=test\n');
  writeFileSync(resolve(root, 'identity.agekey'), 'AGE-SECRET-KEY-TEST\n');

  fakeCommand(fakeBin, 'flock', 'process.exit(0);');
  fakeCommand(fakeBin, 'docker', `
    import { writeFileSync } from 'node:fs';
    const command = process.argv.slice(2).join(' ');
    if (command.includes('pg_dump')) process.stdout.write('event-inbox-custom-dump');
    else if (command.includes('pg_restore --list')) process.stdin.resume();
    else if (command.includes('createdb')) writeFileSync(process.env.FAKE_CREATED_MARKER, command);
    else if (command.includes('exec pg_restore')) process.stdin.resume();
    else if (command.includes('exec psql')) process.stdout.write('ok\\n');
    else if (command.includes('dropdb')) writeFileSync(process.env.FAKE_DROPPED_MARKER, command);
    else throw new Error('Unexpected docker command: ' + command);
  `);
  fakeCommand(fakeBin, 'age', `
    import { copyFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    let output;
    let input;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === '--output') output = args[++index];
      else if (args[index] === '--recipient' || args[index] === '--identity') index += 1;
      else if (!args[index].startsWith('--')) input = args[index];
    }
    if (!input || !output) throw new Error('Fake age requires input and output');
    copyFileSync(input, output);
  `);
  fakeCommand(fakeBin, 'rclone', `
    import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
    import { dirname, resolve } from 'node:path';
    const [command, source, destination] = process.argv.slice(2);
    const path = value => value.startsWith('fake-staging:')
      ? resolve(process.env.FAKE_STAGING_ROOT, value.slice('fake-staging:'.length))
      : value.startsWith('fake:')
        ? resolve(process.env.FAKE_REMOTE_ROOT, value.slice('fake:'.length))
        : value;
    if (command === 'copyto') {
      mkdirSync(dirname(path(destination)), { recursive: true });
      copyFileSync(path(source), path(destination));
    } else if (command === 'cat') {
      process.stdout.write(readFileSync(path(source)));
    } else if (command === 'moveto') {
      mkdirSync(dirname(path(destination)), { recursive: true });
      renameSync(path(source), path(destination));
    } else if (command === 'lsf') {
      for (const name of readdirSync(path(source)).sort()) process.stdout.write(name + '\\n');
    } else throw new Error('Unexpected rclone command: ' + command);
  `);
  fakeCommand(fakeBin, 'sha256sum', `
    import { createHash } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
    if (process.argv[2] === '--check') {
      const line = readFileSync(process.argv[3], 'utf8').trim();
      const [expected, name] = line.split(/  /u);
      if (digest(name) !== expected) process.exit(1);
      process.stdout.write(name + ': OK\\n');
    } else if (!process.argv[2]) {
      const hash = createHash('sha256');
      process.stdin.on('data', chunk => hash.update(chunk));
      process.stdin.on('end', () => process.stdout.write(hash.digest('hex') + '  -\\n'));
    } else {
      process.stdout.write(digest(process.argv[2]) + '  ' + process.argv[2] + '\\n');
    }
  `);

  const environment = {
    ...process.env,
    PATH: `${fakeBin}:/usr/bin:/bin`,
    EVENT_INBOX_DEPLOY_DIR: deploy,
    EVENT_INBOX_BACKUP_WORK_DIR: work,
    EVENT_INBOX_BACKUP_METRICS_DIR: metrics,
    EVENT_INBOX_BACKUP_REMOTE: 'fake:production',
    EVENT_INBOX_BACKUP_STAGING_REMOTE: 'fake-staging:uploads',
    EVENT_INBOX_BACKUP_AGE_RECIPIENT: 'age1testrecipient',
    EVENT_INBOX_BACKUP_AGE_IDENTITY_FILE: resolve(root, 'identity.agekey'),
    FAKE_REMOTE_ROOT: remote,
    FAKE_STAGING_ROOT: staging,
    FAKE_CREATED_MARKER: createdMarker,
    FAKE_DROPPED_MARKER: droppedMarker,
  };
  const backup = spawnSync('/bin/bash', [backupScript], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(backup.status, 0, backup.stderr || backup.stdout);
  const remoteFiles = readdirSync(resolve(remote, 'production')).sort();
  assert.equal(remoteFiles.length, 2);
  const archiveName = remoteFiles.find(name => name.endsWith('.dump.age'));
  assert.ok(archiveName);
  assert.ok(remoteFiles.includes(`${archiveName}.sha256`));
  assert.deepEqual(readdirSync(resolve(staging, 'uploads')), []);
  assert.match(
    readFileSync(resolve(metrics, 'wa-event-inbox-backup.prom'), 'utf8'),
    /^wa_event_inbox_backup_last_success_timestamp_seconds [0-9]+\n$/u,
  );

  const restore = spawnSync('/bin/bash', [restoreScript, archiveName], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(restore.status, 0, restore.stderr || restore.stdout);
  assert.equal(existsSync(createdMarker), true);
  assert.equal(existsSync(droppedMarker), true);
  assert.match(
    readFileSync(resolve(metrics, 'wa-event-inbox-restore-drill.prom'), 'utf8'),
    /^wa_event_inbox_restore_drill_last_success_timestamp_seconds [0-9]+\n$/u,
  );

  const archivePath = resolve(remote, 'production', archiveName);
  writeFileSync(archivePath, `${readFileSync(archivePath, 'utf8')}-tampered`);
  const tampered = spawnSync('/bin/bash', [restoreScript, archiveName], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.notEqual(tampered.status, 0, 'Restore drill accepted a checksum-mismatched archive');
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
  'Event Inbox backup test passed: remote readback, encrypted staging, isolated restore and checksum failure are enforced.\n',
);

function fakeCommand(directory, name, source) {
  const path = resolve(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${source.trim()}\n`);
  chmodSync(path, 0o755);
}
