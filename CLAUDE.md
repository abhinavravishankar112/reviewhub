# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
cp .env.example .env        # DATABASE_URL (Neon/Supabase) + optional GEMINI_API_KEY
npm run db:setup            # schema.sql + seed.sql; safe to re-run (schema.sql DROPs first)
node db/setup.js --schema-only   # rebuild schema without seed data
npm start                   # http://localhost:3000
npm run dev                 # node --watch
curl localhost:3000/api/health  # db, ai backend, queue counters
```

There is no test runner, linter, or build step — plain ESM (`"type": "module"`), Node >= 20, no
bundler. The front end is served as static files and imports its own modules directly.
`npm run db:reset` is declared in package.json but `db/setup.js` only recognises `--schema-only`,
so it behaves the same as `db:setup`.

Without `GEMINI_API_KEY` the app still runs: `src/ai/gemini.js` falls back to a deterministic
keyword extractor (`offlineExtract`). Do not treat a missing key as a broken setup.

## Architecture

Design docs live in [docs/](docs/): [PRD.md](docs/PRD.md) (requirements, acceptance criteria,
known limitations), [HLD.md](docs/HLD.md) (component responsibilities, flows, trade-offs), and
[LLD.md](docs/LLD.md) (API contracts, query inventory, validation rules, known gaps with line
references).

A Postgres-backed review site whose one slow operation — a Gemini call per review — is kept off the
request path.

**Write path:** `POST /api/reviews` → `queries.insertReviewWithTags()` writes `reviews`,
`review_tags` and a `pending` row in `ai_extractions` inside one transaction (`withTransaction` in
[src/db.js](src/db.js)) → `scheduleExtraction()` pushes the model call onto the in-process queue →
201 returns immediately. The browser then polls `GET /api/reviews/:id/extraction` until status is
`done` or `failed`. `POST` to that same path re-runs the job and *awaits* it.

**The queue** ([src/lib/queue.js](src/lib/queue.js)) is a single-worker in-memory queue that
re-arms with `setImmediate` between jobs so the poll phase can serve HTTP. It is deliberately
offered in two styles — `enqueue(job, cb)` and `enqueueAsync(job)`, the latter built by the
hand-written `promisify` in [src/lib/promisify.js](src/lib/promisify.js). Both wrap the *same*
`runExtraction` in [src/extraction.js](src/extraction.js). Jobs are lost on restart; a review
whose extraction never ran keeps `status = 'pending'` forever.

**The model call** is three files: [src/ai/prompt.js](src/ai/prompt.js) (system instruction +
few-shot + the review wrapped in `<review_text>`), [src/ai/schema.js](src/ai/schema.js)
(`buildResponseSchema` + `validateExtraction`), and [src/ai/gemini.js](src/ai/gemini.js) (the
`@google/genai` call with `responseMimeType: 'application/json'`, temperature 0.2,
`thinkingBudget: 0`).

Two invariants hold this together:

- **The output shape is defined once, in the response schema.** The prompt deliberately does *not*
  describe the JSON fields in prose. Don't add a shape description to `prompt.js` — the two will
  drift.
- **The `tags` enum is generated from the `tags` table** (cached 60s in `extraction.js`), so the
  model cannot name a tag that does not exist, and `saveExtraction` resolves slugs by joining
  against `tags` anyway. `validateExtraction()` re-checks ranges and enum membership before
  anything reaches Postgres, mirroring the `CHECK` constraints on `ai_extractions`.
- **The reviewer's own rating is withheld from the model** so `rating_guess` is an independent
  signal. Do not add `rating` to the prompt's grounding metadata.

**All SQL lives in [src/queries.js](src/queries.js)**, exported through the `queries` object;
nothing else in the codebase writes SQL except `db/setup.js` and a `SELECT 1` health check. Every
value is a bound parameter, including the `ILIKE` search.

**Schema** ([db/schema.sql](db/schema.sql)): `users`/`titles` → `reviews` → `review_tags` (junction,
composite PK) and `ai_extractions` (one-to-one via a `UNIQUE` FK). `ON DELETE` is chosen per
relationship: `CASCADE` for owned children, `RESTRICT` on the `tags` side so reference data cannot
vanish under live rows. Business rules are constraints, not just JS validation — `postReview`
translates PG error codes `23505` (duplicate review) and `23503` (unknown user/title) into 409/400.

**Front end** ([public/app.js](public/app.js)) is vanilla ESM, no framework, no build. State lives
in one `state` object; DOM updates go through `scheduleRender(name, fn)`
([public/lib/scheduler.js](public/lib/scheduler.js)), which coalesces a burst into one
`requestAnimationFrame`. Extraction polling uses `poll()` — a self-rescheduling `setTimeout` with
growing delay, never `setInterval`. HTTP mirrors the server's dual style:
`requestJSON(url)` (promise, used everywhere multi-step) and `getJSON(url, cb)` (callback, used
only by `refreshActivity`).

## Working in this codebase

This is a teaching project: the README maps seven named concepts (prompt engineering, structured
outputs, the event loop, hoisting, promises vs callbacks, PK/FK schema design, SQL JOINs) onto the
files that demonstrate them, and long header comments in those files explain *why* the code is
written that way. Several patterns that look like cleanup opportunities are the point of the file
and must be preserved:

- **Function declarations used above their declarations** in `queries.js` (the export map),
  `server.js` (the route table) and `app.js` (`boot()`). Converting these to `const` arrow
  functions would throw at load time and destroy the demonstration.
- **The duplicated callback/promise APIs** in `queue.js`, `promisify.js` and `public/lib/http.js`.
  Neither half is dead code.
- **The self join** in `findRatingDisagreements` and the `LEFT JOIN LATERAL` in `listCritics` are
  chosen for the feature; don't rewrite them as window functions or two round trips.

Keep new comments in the surrounding register — these files explain reasoning, not mechanics — and
when you add a feature that touches one of the seven concepts, update the README's mapping table.
