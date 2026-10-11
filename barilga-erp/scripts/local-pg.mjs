import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const pg = new EmbeddedPostgres({
  databaseDir: path.join(root, 'data', 'pg'),
  user: 'barilga',
  password: 'barilga',
  port: 5432,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
});

async function main() {
  try {
    await pg.initialise();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/exists|already/i.test(msg)) {
      console.warn('initdb:', msg);
    }
  }
  await pg.start();
  try {
    await pg.createDatabase('barilga_erp');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already exists/i.test(msg)) {
      console.warn('createDatabase:', msg);
    }
  }
  console.log('Embedded Postgres ready on postgresql://barilga:barilga@localhost:5432/barilga_erp');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
