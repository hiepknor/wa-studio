import { migrateRuntimeDatabase } from '../src/core/database/runtime-migrations';

async function main(): Promise<void> {
  const result = await migrateRuntimeDatabase();
  for (const file of result.checksumsBackfilled) process.stdout.write(`Recorded checksum ${file}\n`);
  for (const file of result.applied) process.stdout.write(`Applied ${file}\n`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
