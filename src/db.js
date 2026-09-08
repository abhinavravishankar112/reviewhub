// Postgres access layer. One pool for the whole process; `pg` hands out a
// connection per query and returns it automatically.
import pg from 'pg';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env and paste your Neon/Supabase connection string.'
  );
}

// Hosted Postgres (Neon, Supabase) requires TLS; a local socket does not.
const needsSsl = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30_000,
});

// Every value reaches Postgres as a bound parameter ($1, $2, ...), never as
// string concatenation, so user input can never be parsed as SQL.
export function query(text, params = []) {
  return pool.query(text, params);
}

// Runs `fn` inside BEGIN/COMMIT, rolling back on any thrown error. Used by the
// review submission path, which writes to `reviews`, `review_tags` and
// `ai_extractions` and must not leave half a review behind.
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
