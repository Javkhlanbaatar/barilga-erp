// Starts everything the app needs on this computer with one command: the database (embedded Postgres),
// the API (port 4000) and the web app (port 3000, or PORT). Anything already running is left alone. Ctrl+C stops
// what this script started. It never migrates, resets or deletes data; it only warns about pending migrations.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [];
let pg = null;

/** The data folder: PG_DATA_DIR, else ./data/pg, else the older ../data/pg if that is where the data already is. */
function dataDir() {
  if (process.env.PG_DATA_DIR) return path.resolve(process.env.PG_DATA_DIR);
  const inner = path.join(root, 'data', 'pg');
  const outer = path.resolve(root, '..', 'data', 'pg');
  if (!fs.existsSync(inner) && fs.existsSync(path.join(outer, 'PG_VERSION'))) return outer;
  return inner;
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}

async function waitFor(port, label, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    if (await portBusy(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`[dev-all] ${label} did not start on port ${port} within ${seconds}s — see its output above.`);
  return false;
}

function run(label, args) {
  const child = spawn(npm, args, { cwd: root, shell: process.platform === 'win32', env: process.env });
  const prefix = (chunk) =>
    String(chunk)
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .forEach((l) => console.log(`[${label}] ${l}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => console.log(`[${label}] stopped (${code ?? 'signal'})`));
  children.push(child);
  return child;
}

async function startDatabase() {
  if (await portBusy(5432)) {
    console.log('[db] Postgres is already running on 5432 — using it.');
    return;
  }
  const dir = dataDir();
  console.log(`[db] starting embedded Postgres, data folder: ${dir}`);
  pg = new EmbeddedPostgres({ databaseDir: dir, user: 'barilga', password: 'barilga', port: 5432, persistent: true, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
  if (!fs.existsSync(path.join(dir, 'PG_VERSION'))) await pg.initialise();
  try {
    await pg.start();
  } catch (err) {
    console.error('[db] Postgres did not start:', err instanceof Error ? err.message : err);
    console.error(`[db] If the computer was switched off while it ran, a leftover "postmaster.pid" in ${dir} can block it. Make sure no postgres.exe is running, then remove only that file and try again.`);
    process.exit(1);
  }
  try {
    await pg.createDatabase('barilga_erp');
  } catch {
    // already exists
  }
  console.log('[db] ready on localhost:5432');
}

function warnPendingMigrations() {
  const res = spawnSync(npm, ['exec', '-w', '@barilga/api', '--', 'prisma', 'migrate', 'status'], { cwd: root, shell: process.platform === 'win32', encoding: 'utf8' });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (/have not yet been applied|not yet been applied/i.test(out)) {
    console.warn('\n[db] WARNING: the database is missing new migrations; new screens will fail until they are applied.');
    console.warn('[db] Back up first if the data matters, then run:  cd apps/api && npx prisma migrate deploy\n');
  }
}

async function main() {
  await startDatabase();
  warnPendingMigrations();
  if (await portBusy(4000)) console.log('[api] already running on 4000 — using it.');
  else {
    run('api', ['run', 'start:dev', '-w', '@barilga/api']);
    await waitFor(4000, 'API');
  }
  // The web port follows PORT (next dev reads it too), so another app on 3000 is not mistaken for this one.
  const webPort = Number(process.env.PORT) || 3000;
  if (await portBusy(webPort)) console.log(`[web] already running on ${webPort} — using it.`);
  else {
    run('web', ['run', 'dev', '-w', '@barilga/web']);
    await waitFor(webPort, 'Web');
  }
  console.log(`\n[dev-all] Open http://localhost:${webPort}  (Ctrl+C to stop)\n`);
}

async function shutdown() {
  for (const c of children) {
    if (process.platform === 'win32' && c.pid) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F']);
    else c.kill('SIGTERM');
  }
  if (pg) await pg.stop().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch((err) => {
  console.error(err);
  void shutdown();
});
