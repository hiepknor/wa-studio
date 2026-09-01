import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const runtimeRoot = resolve(process.cwd());
const deployRoot = resolve(runtimeRoot, 'deploy/event-inbox');
const systemdRoot = resolve(runtimeRoot, 'deploy/systemd');

describe('Event Inbox deployment contract', () => {
  it('ships executable, encrypted, off-host backup and isolated restore-drill scripts', () => {
    const backupPath = resolve(deployRoot, 'event-inbox-backup.sh');
    const restorePath = resolve(deployRoot, 'event-inbox-restore-drill.sh');
    const backup = readFileSync(backupPath, 'utf8');
    const restore = readFileSync(restorePath, 'utf8');

    expect(statSync(backupPath).mode & 0o111).not.toBe(0);
    expect(statSync(restorePath).mode & 0o111).not.toBe(0);
    expect(backup).toContain('pg_dump');
    expect(backup).toContain('pg_restore --list');
    expect(backup).toContain('age --encrypt');
    expect(backup).toContain('rclone cat');
    expect(backup).toContain('EVENT_INBOX_BACKUP_STAGING_REMOTE');
    expect(backup).toContain('wa_event_inbox_backup_last_success_timestamp_seconds');
    expect(restore).toContain('sha256sum --check');
    expect(restore).toContain('age --decrypt');
    expect(restore).toContain('wa_event_inbox_restore_');
    expect(restore).toContain('event_inbox_usage');
    expect(restore).toContain('wa_event_inbox_restore_drill_last_success_timestamp_seconds');
    expect(restore).not.toContain('dropdb --all');
  });

  it('schedules daily backups and monthly drills under hardened systemd units', () => {
    const backupService = readFileSync(
      resolve(systemdRoot, 'wa-event-inbox-backup.service'),
      'utf8',
    );
    const backupTimer = readFileSync(
      resolve(systemdRoot, 'wa-event-inbox-backup.timer'),
      'utf8',
    );
    const restoreService = readFileSync(
      resolve(systemdRoot, 'wa-event-inbox-restore-drill.service'),
      'utf8',
    );
    const restoreTimer = readFileSync(
      resolve(systemdRoot, 'wa-event-inbox-restore-drill.timer'),
      'utf8',
    );

    for (const service of [backupService, restoreService]) {
      expect(service).toContain('NoNewPrivileges=true');
      expect(service).toContain('ProtectSystem=strict');
      expect(service).toContain('UMask=0077');
      expect(service).toContain('/var/lib/node-exporter/textfile');
    }
    expect(backupTimer).toContain('OnCalendar=*-*-* 01:15:00 UTC');
    expect(restoreTimer).toContain('OnCalendar=monthly');
  });

  it('ships a private, resource-bounded Event Inbox observability overlay', () => {
    const compose = readFileSync(resolve(deployRoot, 'observability.compose.yaml'), 'utf8');
    for (const service of ['prometheus:', 'alertmanager:', 'blackbox-exporter:', 'node-exporter:']) {
      expect(compose).toContain(service);
    }
    expect(compose).toContain('WA_PROMETHEUS_IMAGE:?');
    expect(compose).toContain('/etc/wa-event-inbox/telegram-bot-token');
    expect(compose).toContain('/var/lib/node-exporter/textfile:/textfile:ro');
    expect(compose).not.toMatch(/ports:\s*\n/u);
    expect(compose).toMatch(/event-inbox:\s*\n(?:\s*#[^\n]*\n)?\s*condition: service_started/u);
  });

  it('wires bounded storage and pairing limits into the production Compose profile', () => {
    const compose = readFileSync(resolve(deployRoot, 'compose.yaml'), 'utf8');
    expect(compose).toContain('EVENT_INBOX_MAX_STORED_EVENTS:-500000');
    expect(compose).toContain('EVENT_INBOX_MAX_STORED_BYTES:-2147483648');
    expect(compose).toContain('EVENT_INBOX_PAIR_RATE_LIMIT_MAX_ATTEMPTS');
    expect(compose).toContain('EVENT_INBOX_PAIR_GLOBAL_RATE_LIMIT_MAX_ATTEMPTS');
    expect(compose).toContain('EVENT_INBOX_PAIR_RATE_LIMIT_WINDOW_SECONDS');
    expect(compose).toContain('EVENT_INBOX_METRICS_TOKEN:?EVENT_INBOX_METRICS_TOKEN is required');
    expect(compose).toContain('event-inbox-canary:');
    expect(compose).toContain('migrate-canary:');
    expect(compose).toContain('WA_EVENT_INBOX_CANARY_IMAGE');
    expect(compose).toContain('127.0.0.1:34201:34200');
    expect(compose).toContain("value.status==='ready'&&value.webhookAdmission?.available===true");
  });

  it('exposes only the authenticated connector surface and public liveness through Caddy', () => {
    const caddy = readFileSync(resolve(deployRoot, 'Caddyfile.wa-events'), 'utf8');
    expect(caddy).toContain('path /api/v1/health/live');
    expect(caddy).toContain('{$WA_EVENT_INBOX_UPSTREAM:127.0.0.1:34200}');
    expect(caddy).toContain('method GET POST PUT');
    expect(caddy).toContain('path /api/v1/event-inbox/connectors/*');
    expect(caddy).toContain('path /api/v1/event-inbox/media/*');
    expect(caddy).toContain('path /api/v1/media/*');
    expect(caddy).toContain('{$WA_EVENT_INBOX_CONTROL_UPSTREAM:127.0.0.1:34200}');
    expect(caddy).toContain('max_size 1MB');
    expect(caddy).toContain('max_size 8MB');
    expect(caddy).not.toContain('/api/v1/health/ready');
    expect(caddy).not.toContain('/api/v1/metrics');
  });
});
