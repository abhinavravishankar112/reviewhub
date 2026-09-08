// Creates the schema and loads the seed data.
//   npm run db:setup      -> schema + seed
//   npm run db:setup -- --schema-only
//
// schema.sql starts with DROP TABLE IF EXISTS ... CASCADE, so this is safe to
// re-run; it rebuilds the database from scratch every time.
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaOnly = process.argv.includes('--schema-only');

const files = schemaOnly ? ['schema.sql'] : ['schema.sql', 'seed.sql'];

const client = await pool.connect();
try {
  for (const file of files) {
    const sql = await fs.readFile(path.join(here, file), 'utf8');
    process.stdout.write(`running ${file} ... `);
    await client.query(sql);
    console.log('ok');
  }

  const { rows } = await client.query(`
    SELECT (SELECT COUNT(*) FROM users)          AS users,
           (SELECT COUNT(*) FROM titles)         AS titles,
           (SELECT COUNT(*) FROM reviews)        AS reviews,
           (SELECT COUNT(*) FROM tags)           AS tags,
           (SELECT COUNT(*) FROM review_tags)    AS review_tags,
           (SELECT COUNT(*) FROM ai_extractions) AS extractions
  `);
  console.log('\nrow counts:', rows[0]);
} catch (err) {
  console.error('\nsetup failed:', err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
