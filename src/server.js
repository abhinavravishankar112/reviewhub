// ReviewHub HTTP API + static host.
//
// `import 'dotenv/config'` must be the first import: ES module imports are
// hoisted and evaluated before any statement in this file runs, and they are
// evaluated in source order, so this is the only way to guarantee .env is
// loaded before db.js reads process.env.DATABASE_URL at *its* module scope.
import 'dotenv/config';

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queries } from './queries.js';
import { pool } from './db.js';
import { scheduleExtraction, extractAndWait, aiEnabled } from './extraction.js';
import { stats, pending } from './lib/queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Routes.
//
// CONCEPT: Hoisting — every handler below is referenced here and declared
// further down the file. Function declarations are hoisted with their bodies,
// so `getBootstrap` is already a function by the time this line executes. The
// same file written with `const getBootstrap = async () => {}` would crash on
// load, because a `const` is hoisted into the scope but left uninitialised
// until its own line runs (the temporal dead zone).
// ---------------------------------------------------------------------------
app.get('/api/bootstrap',                 wrap(getBootstrap));
app.get('/api/titles',                    wrap(getTitles));
app.get('/api/titles/:id',                wrap(getTitleDetail));
app.get('/api/critics',                   wrap(getCritics));
app.get('/api/tags/:slug/reviews',        wrap(getReviewsByTag));
app.get('/api/disagreements',             wrap(getDisagreements));
app.get('/api/activity',                  wrap(getActivity));
app.post('/api/reviews',                  wrap(postReview));
app.get('/api/reviews/:id/extraction',    wrap(getExtractionStatus));
app.post('/api/reviews/:id/extraction',   wrap(rerunExtraction));
app.get('/api/health',                    wrap(getHealth));

app.use(handleError);

app.listen(PORT, () => {
  console.log(`ReviewHub listening on http://localhost:${PORT}`);
  console.log(aiEnabled
    ? `Gemini enabled (${process.env.GEMINI_MODEL || 'gemini-2.5-flash'})`
    : 'GEMINI_API_KEY not set — using the offline extractor');
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

// Everything the front end needs before it can render anything: who can post,
// and what the tag vocabulary is.
async function getBootstrap(req, res) {
  // Two independent queries, so they are started together and awaited as a
  // pair rather than one after the other. Both promises are already in flight
  // while the event loop waits; Promise.all just collects them.
  const [tags, activity] = await Promise.all([
    queries.listTagCloud(),
    queries.listRecentActivity(6),
  ]);

  const { rows: users } = await pool.query(
    'SELECT id, username, display_name FROM users ORDER BY display_name'
  );

  res.json({ users, tags, activity, aiEnabled });
}

async function getTitles(req, res) {
  const kind = req.query.kind === 'movie' || req.query.kind === 'book' ? req.query.kind : null;
  const search = typeof req.query.q === 'string' && req.query.q.trim() !== ''
    ? req.query.q.trim().slice(0, 80)
    : null;

  res.json(await queries.listTitles({ kind, search }));
}

async function getTitleDetail(req, res) {
  const id = toId(req.params.id);
  const [title, reviews] = await Promise.all([
    queries.getTitle(id),
    queries.listReviewsForTitle(id),
  ]);

  if (!title) return res.status(404).json({ error: 'No such title' });
  res.json({ title, reviews });
}

async function getCritics(req, res) {
  res.json(await queries.listCritics());
}

async function getReviewsByTag(req, res) {
  res.json(await queries.listReviewsByTag(String(req.params.slug).slice(0, 32)));
}

async function getDisagreements(req, res) {
  res.json(await queries.findRatingDisagreements(2));
}

async function getActivity(req, res) {
  res.json(await queries.listRecentActivity(10));
}

// The write path. Validate, insert in a transaction, then hand the slow part
// to the background queue and answer straight away.
async function postReview(req, res) {
  const problems = validateReviewBody(req.body);
  if (problems.length > 0) return res.status(400).json({ error: problems.join('; ') });

  const { userId, titleId, rating, body, tags = [] } = req.body;

  let review;
  try {
    review = await queries.insertReviewWithTags({
      userId, titleId, rating, body,
      tagSlugs: tags.slice(0, 3).map(String),
    });
  } catch (err) {
    // 23505 = unique_violation: the (user_id, title_id) constraint fired.
    if (err.code === '23505') {
      return res.status(409).json({ error: 'That critic has already reviewed this title.' });
    }
    // 23503 = foreign_key_violation: a user_id or title_id that does not exist.
    if (err.code === '23503') {
      return res.status(400).json({ error: 'Unknown critic or title.' });
    }
    throw err;
  }

  // Fire and forget, callback style. The model call takes seconds; the client
  // gets its 201 in milliseconds and polls /extraction for the result.
  scheduleExtraction(review.id);

  res.status(201).json({ id: review.id, created_at: review.created_at, ai_status: 'pending' });
}

async function getExtractionStatus(req, res) {
  const row = await queries.getExtraction(toId(req.params.id));
  if (!row) return res.status(404).json({ error: 'No extraction for that review' });
  res.json(row);
}

// The awaited twin of scheduleExtraction: same queue, but this request stays
// open until the job resolves.
async function rerunExtraction(req, res) {
  const id = toId(req.params.id);
  const data = await extractAndWait(id);
  res.json({ review_id: id, ...data });
}

async function getHealth(req, res) {
  const { rows } = await pool.query('SELECT 1 AS ok');
  res.json({
    db: rows[0].ok === 1 ? 'up' : 'down',
    ai: aiEnabled ? 'gemini' : 'offline-fallback',
    queue: { pending: pending(), ...stats },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Express 5 forwards a rejected promise to the error handler on its own, but
// wrapping keeps that explicit and keeps this working if the handlers are ever
// mounted on an older router.
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

function validateReviewBody(body) {
  const problems = [];
  if (!body || typeof body !== 'object') return ['request body must be JSON'];

  if (!Number.isInteger(body.userId)) problems.push('userId must be an integer');
  if (!Number.isInteger(body.titleId)) problems.push('titleId must be an integer');
  if (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 10) {
    problems.push('rating must be an integer between 1 and 10');
  }
  if (typeof body.body !== 'string' || body.body.trim().length < 15) {
    problems.push('review must be at least 15 characters');
  }
  if (typeof body.body === 'string' && body.body.length > 4000) {
    problems.push('review must be under 4000 characters');
  }
  if (body.tags !== undefined && !Array.isArray(body.tags)) {
    problems.push('tags must be an array of slugs');
  }
  return problems;
}

function toId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : -1;
}

function handleError(err, req, res, next) {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Something went wrong' });
}
