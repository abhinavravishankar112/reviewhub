# ReviewHub

A site where people review films and books. Every review is written by a human;
a background worker then sends it to Gemini under a schema-constrained prompt
and stores the result as a structured record — headline, sentiment, an implied
score judged from the wording alone, spoiler risk, and tags drawn from the
site's own vocabulary. The catalogue, the critics table and the "where critics
disagree" page are all read straight out of Postgres with joins.

```
Browser ──POST /api/reviews──> Express ──BEGIN──> Postgres   (reviews, review_tags, ai_extractions)
                                  │  201 in ~10ms
                                  └──> job queue ──> Gemini (prompt + response schema) ──> UPDATE ai_extractions
Browser ──poll /extraction───────────────────────────────────────────────────────────────> reads it back
```

## Running it

```bash
npm install
cp .env.example .env       # paste your DATABASE_URL and GEMINI_API_KEY
npm run db:setup           # creates the schema and loads seed data
npm start                  # http://localhost:3000
```

`db:setup` is safe to re-run — `schema.sql` drops and rebuilds everything.
Without `GEMINI_API_KEY` the site still runs; extraction falls back to a local
keyword scorer so nothing is broken during a demo.

## Where each required concept lives

| Concept | Where | What it is doing |
|---|---|---|
| **Prompt engineering** | [`src/ai/prompt.js`](src/ai/prompt.js) | Role, numbered procedure, negative constraints, delimited untrusted input, one few-shot example, grounding metadata. The reviewer's own score is deliberately withheld from the model so `rating_guess` is an independent signal. |
| **Structured outputs** | [`src/ai/schema.js`](src/ai/schema.js), [`src/ai/gemini.js`](src/ai/gemini.js) | `responseMimeType: application/json` + a response schema constrains decoding to one shape. The `tags` enum is generated from the `tags` table, so the model can only pick slugs that exist. `validateExtraction()` re-checks ranges and membership before anything is written. |
| **Event loop** | [`src/lib/queue.js`](src/lib/queue.js), [`public/lib/scheduler.js`](public/lib/scheduler.js) | Server: the model call runs in a queue that yields with `setImmediate` between jobs so the poll phase can serve requests; callbacks fire via `queueMicrotask` so they are never synchronous. Client: renders coalesce in a microtask, search debounces on a timer, and the extraction poll re-arms with `setTimeout` *after* each response rather than on a `setInterval`. |
| **Hoisting** | [`src/queries.js`](src/queries.js), [`src/server.js`](src/server.js), [`public/app.js`](public/app.js) | Each of these files uses its functions above their declarations — the export map, the route table, and `boot()` — which works because function declarations are hoisted with their bodies, unlike `const` bindings, which sit in the temporal dead zone. The comments say why the same code written with arrow consts would throw. |
| **Promises vs callbacks** | [`src/lib/queue.js`](src/lib/queue.js), [`src/lib/promisify.js`](src/lib/promisify.js), [`public/lib/http.js`](public/lib/http.js) | The queue exposes the same job in both styles: `enqueue(job, cb)` and `enqueueAsync(job)`, the second built from the first by a hand-written `promisify`. Posting a review uses the callback (fire and forget); the re-run endpoint awaits the promise. The client mirrors this with `getJSON(url, cb)` and `requestJSON(url)`. |
| **Relational schema (PK/FK)** | [`db/schema.sql`](db/schema.sql) | Six tables, identity primary keys, a foreign key on every relationship with a deliberate `ON DELETE` rule per case, a junction table keyed on the pair, a one-to-one enforced by `UNIQUE` on a FK, plus `CHECK` and `UNIQUE` business rules and hand-made indexes on the referencing columns. |
| **SQL JOINs** | [`src/queries.js`](src/queries.js) | `LEFT JOIN` + aggregate for the catalogue (titles with no reviews must survive), a four-table read for a title page, `LEFT JOIN LATERAL` for each critic's top title, a many-to-many traversal through `review_tags`, and a **self join** on `reviews` for the disagreements page. |

## Schema

```
users ──1:N──> reviews <──N:1── titles
                  │
                  ├──1:N──> review_tags ──N:1──> tags     (many-to-many)
                  └──1:1──> ai_extractions                (UNIQUE fk)
```

* `reviews (user_id, title_id)` is `UNIQUE` — one review per person per title.
* `reviews.rating` is `CHECK (rating BETWEEN 1 AND 10)`; the API's validation is
  a convenience, the constraint is the actual guarantee.
* `review_tags` has `PRIMARY KEY (review_id, tag_id)`, so a tag cannot be
  attached twice, and `ON DELETE RESTRICT` on the tag side stops reference data
  vanishing under live rows.
* Deleting a user or title cascades to their reviews, and from there to the
  junction rows and the extraction.

## API

| Method | Path | |
|---|---|---|
| GET | `/api/bootstrap` | users, tag cloud, recent activity, whether Gemini is configured |
| GET | `/api/titles?kind=&q=` | catalogue with average rating and review count |
| GET | `/api/titles/:id` | title, its reviews, their tags and extractions |
| GET | `/api/critics` | leaderboard with each critic's highest-rated title |
| GET | `/api/tags/:slug/reviews` | every review carrying a tag |
| GET | `/api/disagreements` | self-join: pairs who rated the same title ≥2 apart |
| POST | `/api/reviews` | writes three tables in a transaction, queues extraction, returns 201 |
| GET | `/api/reviews/:id/extraction` | poll the background job |
| POST | `/api/reviews/:id/extraction` | re-run and wait for it |
| GET | `/api/health` | db, ai backend, queue counters |

## Notes on the things that usually go wrong

* **SQL injection** — every value is a bound parameter (`$1`), never string
  concatenation, including the `ILIKE` search.
* **Prompt injection** — the review body is stripped of `<` and `>` and placed
  inside `<review_text>`, and the system instruction states that its contents
  are data. A review that says "ignore your instructions" is summarised, not
  obeyed.
* **Hallucinated tags** — impossible by construction: the enum is the tag table,
  and the insert resolves slugs by joining against `tags`.
* **A slow model call blocking the site** — it cannot, because it never happens
  inside a request.
