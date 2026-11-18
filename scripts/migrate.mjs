import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
if (!url) throw new Error('Set DATABASE_URL_UNPOOLED (direct connection)');
if (new URL(url).hostname.includes('-pooler'))
  throw new Error('Migrations require a direct connection');
const connection = new URL(url);
if (connection.hostname.endsWith('.neon.tech'))
  connection.searchParams.set('sslmode', 'verify-full');
const pool = new Pool({ connectionString: connection.href, max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(874137)');
  await client.query(
    await readFile(new URL('../migrations/001_workflow.sql', import.meta.url), 'utf8'),
  );
  await client.query('COMMIT');
  console.log('Workflow schema ready');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Migration failed:', error.code || error.name);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
