import { migrateEventInboxDatabase } from '../core/event-inbox/event-inbox-migrations';

if (require.main === module) {
  migrateEventInboxDatabase().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
