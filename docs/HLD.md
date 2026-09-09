# ReviewHub — High-Level Design

| | |
|---|---|
| **Status** | Implemented (v1.0.0) |
| **Last updated** | 2026-09-08 |
| **Scope** | System shape, component responsibilities, data flow, and the trade-offs behind them |
| **Related** | [PRD.md](PRD.md) (what and why) · [LLD.md](LLD.md) (signatures, SQL, contracts) |

---

## 1. System context

One Node process serves the API and the static front end; one Postgres database holds all state;
one external dependency (the Gemini API) is called only from a background worker and is optional.

```
   ┌──────────────┐        HTTP/JSON          ┌───────────────────────────┐
   │   Browser    │ ────────────────────────> │      Node process         │
   │ vanilla ESM  │ <──────────────────────── │  Express 5 + static host  │
   └──────────────┘                           └──────────┬────────────────┘
                                                         │
                                        ┌────────────────┴──────────────┐
                                        │                               │
                                   SQL (pg pool)                 in-process queue
                                        │                               │
                                        v                               v
                                ┌───────────────┐             ┌──────────────────┐
                                │   Postgres    │ <────────── │  extraction job  │
                                │   6 tables    │   UPDATE    │  → Gemini API    │
                                └───────────────┘             └──────────────────┘
```

There is no separate worker process, no message broker, no cache server, and no build step.

## 2. Design drivers

Four constraints shape every structural decision:

| Driver | Consequence |
|---|---|
| **The slow thing must not be on the request path** | The model call runs in a background queue; the write path returns as soon as Postgres commits. |
| **Node is single-threaded** | The queue yields to the event loop between jobs, so a backlog cannot starve HTTP. |
| **The model's output is a database row** | Its shape is constrained at decode time by a response schema, then validated again before the INSERT. |
| **The relational model is the product** | Aggregation, navigation and comparison are done in SQL joins, not in JavaScript over fetched arrays. |

## 3. Components

### 3.1 HTTP layer — `src/server.js`

Express 5. Owns routing, input validation, HTTP status semantics, and the translation of Postgres
error codes into client-meaningful responses. It contains no SQL beyond a health-check `SELECT 1`
and one small users query, and it never calls the model directly — only `scheduleExtraction()` and
`extractAndWait()`.

Handlers are wrapped so a rejected promise reaches the error middleware. Static files are served
from `public/` by the same process.

### 3.2 Data access — `src/queries.js`, `src/db.js`

**Every SQL statement in the application lives in `queries.js`**, exposed as one exported object.
This is the single most important structural rule in the codebase: it makes the query surface
auditable in one file, and it is what keeps parameter binding universal.

`db.js` owns the connection pool (max 5), TLS selection (on unless the host is localhost), the
parameterised `query()` helper, and `withTransaction()`, which brackets a function in
`BEGIN`/`COMMIT` with rollback on throw.

### 3.3 Background queue — `src/lib/queue.js`, `src/lib/promisify.js`

A single-worker, in-memory FIFO. Jobs are functions returning promises. The drain loop awaits one
job, reports through its callback, then schedules the next with `setImmediate` — deferring to the
*check* phase so the *poll* phase runs first and inbound sockets are read **between** jobs. A
plain `while (queue.length)` loop would drain the whole backlog before the server answered
anyone.

The queue is deliberately exposed in both async styles over the same job:

- `enqueue(job, cb)` — Node-style, error-first, used for fire-and-forget work
- `enqueueAsync(job)` — the same thing as a promise, produced by the hand-written `promisify()`

Failures never take the worker down: the error goes to the job's callback and the loop continues.

### 3.4 Extraction orchestration — `src/extraction.js`

The seam between the queue, the database and the model. `runExtraction(reviewId)` marks the row
`running`, reads the review with its author and title, fetches the tag vocabulary (cached 60 s
because it is needed on every extraction and changes almost never), calls the model, and writes
the result — or records the failure on the row.

It exposes the same work twice, mirroring the queue's two styles: `scheduleExtraction()` (fire and
forget, used by `POST /api/reviews`) and `extractAndWait()` (awaited, used by the re-run
endpoint).

### 3.5 Model interface — `src/ai/`

Three files with one responsibility each:

- **`prompt.js`** — the system instruction (role, numbered procedure, negative constraints), one
  few-shot exchange, the grounding metadata block, and the sanitiser that wraps untrusted review
  text in `<review_text>`.
- **`schema.js`** — `buildResponseSchema(tagSlugs)`, which generates the response schema *from the
  live tag vocabulary*, and `validateExtraction()`, the second line of defence.
- **`gemini.js`** — the `@google/genai` call and its decoding parameters, plus the offline
  fallback extractor used when no API key is configured.

**The output shape is defined in exactly one place — the response schema.** The prompt
deliberately does not describe the JSON fields in prose; two descriptions would drift apart.

### 3.6 Front end — `public/`

Vanilla ES modules, served directly, no framework and no bundler. One `state` object; three views
(catalogue, critics, disagreements) plus a title sheet overlay.

- **`lib/http.js`** — `requestJSON(url)` (promise) and `getJSON(url, cb)` (callback), the client
  mirror of the server's dual style.
- **`lib/scheduler.js`** — `scheduleRender(name, fn)` coalesces a burst of state changes into one
  `requestAnimationFrame`; `debounce()` for search; `poll()` for extraction watching.

## 4. Key flows

### 4.1 Read — catalogue

```
GET /api/titles?kind=&q=  →  listTitles()  →  one LEFT JOIN + aggregate  →  JSON array
```

One query per view. Aggregation (`COUNT`, `AVG`) happens in Postgres; the client renders what it
receives.

### 4.2 Write — posting a review

```
Browser                Express              Postgres                 Queue            Gemini
   │  POST /api/reviews   │                    │                       │                │
   ├─────────────────────>│  validate          │                       │                │
   │                      ├───── BEGIN ───────>│                       │                │
   │                      │   INSERT reviews   │                       │                │
   │                      │   INSERT review_tags (slugs resolved by JOIN)               │
   │                      │   INSERT ai_extractions ('pending')        │                │
   │                      ├───── COMMIT ──────>│                       │                │
   │                      ├─ scheduleExtraction() ───────────────────> │  (returns now) │
   │  201 {id, pending}   │                    │                       │                │
   │<─────────────────────┤                    │                       │                │
   │                      │                    │        setImmediate → drain            │
   │                      │                    │                       ├───────────────>│
   │  GET .../extraction  │                    │  UPDATE 'running'     │                │
   ├─────────────────────>│  (poll, backing off)                       │<───────────────┤
   │                      │                    │<── UPDATE 'done' ─────┤                │
   │  {status:'done',...} │                    │                       │                │
   │<─────────────────────┤                    │                       │                │
```

Three tables are written in **one transaction**, so a review never exists without its pending
extraction record. The 201 is returned before the model is called at all.

### 4.3 Re-run

`POST /api/reviews/:id/extraction` puts the *same* job on the *same* queue but awaits it via
`enqueueAsync`, so the HTTP response carries the new record and the client has nothing to poll
for. This is the deliberate contrast to §4.2: one job, two delivery styles.

## 5. Data architecture

Six tables. The shape is chosen so that each product view is one join away.

| Table | Role | Notable constraint |
|---|---|---|
| `users` | Review authors | `username` format check, unique |
| `titles` | Movies and books in one table | `kind IN ('movie','book')`; unique on `(kind, name, release_year)` |
| `tags` | Controlled vocabulary (reference data) | slug format check, unique |
| `reviews` | The fact table joining users to titles | rating 1–10, body 15–4000, **unique `(user_id, title_id)`** |
| `review_tags` | Junction resolving reviews ↔ tags | composite PK on the pair; `RESTRICT` on the tag side |
| `ai_extractions` | The derived record | **`UNIQUE` FK** to `reviews` (one-to-one); status/sentiment/spoiler/rating checks |

Two deliberate choices worth stating:

- **`ON DELETE` is chosen per relationship**, not applied uniformly: `CASCADE` for rows a parent
  owns (a user's reviews, a review's tags and extraction), `RESTRICT` where reference data must
  not disappear underneath live rows (a tag in use).
- **Foreign-key columns are indexed by hand.** Postgres indexes primary keys and unique
  constraints automatically but *not* the referencing side of a foreign key — and every join in
  the application drives through those columns.

Business rules live as `CHECK`/`UNIQUE` constraints rather than only in JavaScript, so the API's
validation is a convenience and the constraint is the guarantee. The API's job is to translate a
violation into a good HTTP response, not to be the last line of defence.

## 6. Cross-cutting concerns

### 6.1 Concurrency model

Everything runs on one event loop. The two places that matter:

- **Server** — `setImmediate` between queued jobs keeps the poll phase alive; `queueMicrotask` is
  used to guarantee that `enqueue()`'s error callback is never invoked synchronously (a callback
  that is sometimes sync and sometimes async makes call sites unreasonable).
- **Client** — renders coalesce in a microtask then commit in `requestAnimationFrame`; search
  debounces on a timer; extraction polling re-arms with `setTimeout` **after** each response
  rather than on a `setInterval`, so overlapping in-flight requests are structurally impossible.

### 6.2 Error handling

| Layer | Strategy |
|---|---|
| SQL | Constraint violations propagate as PG error codes; `23505` → 409, `23503` → 400 |
| Queue | A failing job is reported to its callback; the worker continues; `stats.failed` increments |
| Extraction | Failure is written to the row (`status='failed'`, `error`), so it is visible in the UI and re-runnable |
| Fire-and-forget path | Errors are logged, not propagated — there is no longer a request to propagate to |
| HTTP | One error middleware returns 500 |

### 6.3 Security posture

Defence is structural wherever possible rather than filter-based: bound parameters make SQL
injection impossible rather than unlikely; the tag enum being generated from the tag table makes
a hallucinated tag impossible rather than filtered; the model never being called in a request
handler makes a slow model blocking the site impossible rather than rare. Prompt injection is the
one area handled by convention (delimiting, sanitising, and an explicit system-instruction rule)
because no structural guarantee exists.

There is **no authentication**; see §7.

### 6.4 Degraded operation

A missing `GEMINI_API_KEY` selects a deterministic local keyword extractor at module load. Every
code path downstream is identical — same validation, same writes, same statuses — and the stored
`model` column reads `offline-fallback` so the two are never confused after the fact.

## 7. Trade-offs and their limits

| Decision | Bought | Cost |
|---|---|---|
| In-memory queue instead of a jobs table or broker | No infrastructure; the whole mechanism is ~90 readable lines | Jobs are lost on restart, leaving reviews `pending` with nothing to finish them; no retry, no backoff, no visibility beyond three counters |
| Single process, single worker | Ordering is trivial; no coordination | Extraction throughput is one job at a time; two processes behind a load balancer would each keep their own queue |
| No auth | Nothing to build; the demo is one click | Any caller may post as any critic; edit/delete cannot be added safely until this changes |
| All SQL in one file | Auditable, consistent, parameterised | The file grows with the product; it is the natural split point if the app is ever divided |
| No pagination | Simpler client and simpler SQL | Every list endpoint returns the full result set; the catalogue and tag views degrade as data grows |
| Vanilla front end, no build | Zero toolchain; the served file is the source file | Manual DOM work; no component reuse beyond functions |
| Tag vocabulary cached 60 s in-process | Removes a query from every extraction | A newly added tag is invisible to the model for up to a minute, and each process caches separately |

## 8. Deployment and operations

- **Runtime**: Node ≥ 20, ESM throughout, `PORT` (default 3000).
- **Configuration**: `DATABASE_URL` (required — the process refuses to start without it),
  `GEMINI_API_KEY` (optional), `GEMINI_MODEL` (default `gemini-2.5-flash`).
- **Schema management**: `db/schema.sql` drops and recreates everything, so `npm run db:setup` is
  idempotent and destructive by design. There are no migrations; the schema is versioned as a
  whole file.
- **Health**: `GET /api/health` returns database reachability, the active extraction backend, and
  the queue's pending/completed/failed counters.
- **Observability**: `console` logging only. Job completion and failure are logged per review; the
  failure is additionally persisted on the extraction row, which is the durable record.

## 9. Evolution path

The design is deliberately small, and the seams where it would grow are already in place:

1. **Durability of jobs** — the queue's interface (`enqueue`/`enqueueAsync`) is narrow enough to
   be re-implemented over a jobs table without touching `extraction.js`, `server.js`, or the
   front end. A boot-time sweep of rows stuck in `pending`/`running` is the smallest useful step.
2. **A second process** — requires moving the queue out of memory first; nothing else in the
   design assumes a single instance except the tag cache.
3. **Auth** — `userId` in the request body becomes the session identity; the write path and the
   unique constraint are unchanged.
4. **Pagination** — `queries.js` is the only file that changes on the server.
5. **Model quality tracking** — `raw_json` already stores the full extraction per review, so
   agreement between `rating_guess` and `rating` is a query away, not a schema change.
