# ReviewHub — Low-Level Design

| | |
|---|---|
| **Status** | Implemented (v1.0.0) |
| **Last updated** | 2026-09-08 |
| **Scope** | Module contracts, API specification, SQL, validation rules, failure behaviour |
| **Related** | [PRD.md](PRD.md) (what and why) · [HLD.md](HLD.md) (system shape) |

Line references point at the current implementation and are the source of truth where this
document and the code disagree.

---

## 1. Module map

| Module | Exports | Depends on |
|---|---|---|
| [src/server.js](../src/server.js) | — (entry point) | `queries`, `db`, `extraction`, `lib/queue` |
| [src/db.js](../src/db.js) | `pool`, `query`, `withTransaction` | `pg` |
| [src/queries.js](../src/queries.js) | `queries` (14 functions) | `db` |
| [src/extraction.js](../src/extraction.js) | `scheduleExtraction`, `extractAndWait`, `aiEnabled` | `queries`, `ai/gemini`, `lib/queue` |
| [src/lib/queue.js](../src/lib/queue.js) | `enqueue`, `enqueueAsync`, `stats`, `pending` | `lib/promisify` |
| [src/lib/promisify.js](../src/lib/promisify.js) | `promisify` | — |
| [src/ai/gemini.js](../src/ai/gemini.js) | `extractReview`, `aiEnabled` | `@google/genai`, `ai/prompt`, `ai/schema` |
| [src/ai/prompt.js](../src/ai/prompt.js) | `SYSTEM_INSTRUCTION`, `buildContents` | — |
| [src/ai/schema.js](../src/ai/schema.js) | `SENTIMENTS`, `SPOILER_RISKS`, `buildResponseSchema`, `validateExtraction` | — |
| [public/app.js](../public/app.js) | — (entry point) | `lib/http`, `lib/scheduler` |
| [public/lib/http.js](../public/lib/http.js) | `requestJSON`, `getJSON` | `fetch` |
| [public/lib/scheduler.js](../public/lib/scheduler.js) | `scheduleRender`, `debounce`, `poll` | — |

**Load-order requirement:** `import 'dotenv/config'` is the first import in both
[src/server.js](../src/server.js) and [db/setup.js](../db/setup.js). ES module imports are hoisted
and evaluated in source order before any statement in the importing module, and
[src/db.js](../src/db.js#L7) reads `process.env.DATABASE_URL` *at module scope* — so any other
ordering throws on start-up.

## 2. API specification

All responses are JSON. All errors are `{ "error": string }`.

### `GET /api/bootstrap`
Everything the client needs before first render.
```jsonc
{ "users":    [{ "id", "username", "display_name" }],
  "tags":     [{ "id", "slug", "label", "use_count" }],
  "activity": [{ "id", "rating", "created_at", "display_name", "title_name",
                 "cover_emoji", "ai_status" }],
  "aiEnabled": true }
```
Issues `listTagCloud()` and `listRecentActivity(6)` concurrently via `Promise.all`, then the users
query ([server.js:62](../src/server.js#L62)).

### `GET /api/titles?kind=&q=`
| Param | Handling |
|---|---|
| `kind` | Accepted only if exactly `movie` or `book`; anything else → `null` (no filter) |
| `q` | Trimmed, **truncated to 80 chars**; empty → `null` |

Returns titles with `review_count` and `avg_rating` (1 dp, `null` when unreviewed).

### `GET /api/titles/:id`
`{ title, reviews }`. `getTitle()` and `listReviewsForTitle()` run concurrently; **404** if the
title does not exist. Each review carries `ai_status`, `ai_headline`, `ai_summary`,
`ai_sentiment`, `ai_rating_guess`, `ai_spoiler_risk`, and a `tags` array of labels.

### `GET /api/critics`
Leaderboard: `review_count`, `avg_rating`, `favourite_title`, `favourite_emoji`.

### `GET /api/tags/:slug/reviews`
Slug is truncated to 32 chars. Returns reviews carrying the tag, each with a 240-char `excerpt`,
highest rating first. An unknown slug yields `[]`, not a 404.

### `GET /api/disagreements`
Critic pairs on the same title with a gap ≥ 2, widest first, **max 10 rows**.

### `GET /api/activity`
The 10 most recent reviews with extraction status.

### `POST /api/reviews`
```jsonc
// request
{ "userId": 1, "titleId": 3, "rating": 8, "body": "…", "tags": ["slow-burn"] }
// 201
{ "id": 42, "created_at": "…", "ai_status": "pending" }
```
| Status | Cause |
|---|---|
| 201 | Committed. Extraction queued, not yet run. |
| 400 | Validation failure (all problems joined with `; `), or PG `23503` — unknown critic or title |
| 409 | PG `23505` — that critic has already reviewed that title |
| 500 | Anything else |

Only the first 3 tags are used; each is coerced with `String()`
([server.js:116](../src/server.js#L116)).

### `GET /api/reviews/:id/extraction`
The polling endpoint. **404** when no `ai_extractions` row exists for that review.
```jsonc
{ "status": "pending|running|done|failed",
  "model", "headline", "summary", "sentiment", "rating_guess",
  "spoiler_risk", "error", "completed_at", "user_rating" }
```

### `POST /api/reviews/:id/extraction`
Re-runs and **awaits** the job. Returns `{ review_id, ...extractionData }` — the validated
extraction object, not the database row. Throws → 500 if the review no longer exists.

### `GET /api/health`
`{ db: "up"|"down", ai: "gemini"|"offline-fallback", queue: { pending, queued, completed, failed } }`

## 3. Validation

### 3.1 Request validation — `validateReviewBody()` ([server.js:181](../src/server.js#L181))

Collects **all** problems rather than failing on the first:

| Field | Rule |
|---|---|
| `userId`, `titleId` | `Number.isInteger` |
| `rating` | integer, 1 ≤ r ≤ 10 |
| `body` | string, `trim().length ≥ 15`, raw `length ≤ 4000` |
| `tags` | if present, must be an array |

`toId()` ([server.js:202](../src/server.js#L202)) parses path params and returns `-1` for anything
non-positive or unparseable, which reliably misses every identity key and produces a 404.

### 3.2 Extraction validation — `validateExtraction()` ([schema.js:84](../src/ai/schema.js#L84))

Runs **after** schema-constrained decoding, because a schema constrains shape, not meaning.

| Field | Coercion | Rejection |
|---|---|---|
| `headline` | trim, ≤ 80 chars | missing/blank |
| `summary` | trim, ≤ 400 chars | missing/blank |
| `sentiment` | — | not in `SENTIMENTS` |
| `rating_guess` | — | not an integer 1–10 |
| `spoiler_risk` | defaults to `'none'` if unrecognised | never rejects |
| `praised`, `criticised` | strings only, trimmed, ≤ 60 chars each, **max 3** | never rejects |
| `tags` | as above, then filtered against the allowed slug list | never rejects |

Returns `{ ok: true, data }` or `{ ok: false, problems: string[] }`. A rejection is thrown by
`extractReview()` and recorded on the row by `failExtraction()`.

These limits mirror the database's `CHECK` constraints deliberately, so a bad extraction fails
here with a readable message instead of mid-`UPDATE`.

## 4. Database

### 4.1 DDL summary ([db/schema.sql](../db/schema.sql))

All primary keys are `INTEGER GENERATED ALWAYS AS IDENTITY`.

| Table | Columns of note | Constraints |
|---|---|---|
| `users` | `username`, `display_name` | `username` unique + `~ '^[a-z0-9_]{3,24}$'` |
| `titles` | `kind`, `name`, `creator`, `release_year`, `cover_emoji`, `blurb` | `kind IN ('movie','book')`; year 1400–2100 or null; unique `(kind, name, release_year)` |
| `tags` | `slug`, `label` | `slug` unique + `~ '^[a-z0-9-]{2,32}$'` |
| `reviews` | `user_id`→users CASCADE, `title_id`→titles CASCADE, `rating`, `body` | rating 1–10; `char_length(body)` 15–4000; **unique `(user_id, title_id)`** |
| `review_tags` | `review_id`→reviews CASCADE, `tag_id`→tags **RESTRICT** | **PK `(review_id, tag_id)`** |
| `ai_extractions` | `review_id`→reviews CASCADE **UNIQUE**, `status`, `model`, `headline`, `summary`, `sentiment`, `rating_guess`, `spoiler_risk`, `raw_json` JSONB, `error`, `completed_at` | status ∈ pending/running/done/failed; sentiment and spoiler_risk enum-or-null; `rating_guess` 1–10 or null |

Hand-made indexes — the referencing side of a foreign key is **not** indexed automatically, and
every join drives through these:
`reviews (user_id)`, `reviews (title_id)`, `review_tags (tag_id)`, `ai_extractions (status)`.

### 4.2 Query inventory ([src/queries.js](../src/queries.js))

| Function | Join shape | Why that shape |
|---|---|---|
| `listTitles` [:40](../src/queries.js#L40) | `titles LEFT JOIN reviews`, `GROUP BY t.id` | An unreviewed title must survive; INNER would drop it |
| `getTitle` [:65](../src/queries.js#L65) | same, single row | — |
| `listReviewsForTitle` [:91](../src/queries.js#L91) | `reviews INNER JOIN users`, `LEFT JOIN ai_extractions`, `LEFT JOIN review_tags → tags` | INNER for the author (a review always has one); LEFT for an extraction that may not exist yet. `array_agg(...) FILTER (WHERE tg.id IS NOT NULL)` collapses the tag fan-out back to one row per review instead of N+1 queries |
| `listCritics` [:131](../src/queries.js#L131) | `users INNER JOIN reviews` + `LEFT JOIN LATERAL` top-rated title | LATERAL gets each critic's favourite in the same round trip |
| `listTagCloud` [:162](../src/queries.js#L162) | `tags LEFT JOIN review_tags` | Keeps unused tags, so a count of 0 is real information |
| `listReviewsByTag` [:180](../src/queries.js#L180) | five tables, all INNER | Only reviews genuinely carrying the tag, each of which necessarily has an author and a title |
| `findRatingDisagreements` [:210](../src/queries.js#L210) | **self join** `reviews a` ⋈ `reviews b` on `b.title_id = a.title_id AND a.user_id < b.user_id` | The `<` predicate yields one row per pair rather than both directions, and excludes self-pairing |
| `listRecentActivity` [:235](../src/queries.js#L235) | reviews ⋈ users ⋈ titles, LEFT extractions | — |
| `getExtraction` [:259](../src/queries.js#L259) | `ai_extractions INNER JOIN reviews` | Returns `user_rating` alongside, so the UI can compare the two scores in one request |
| `getReviewForExtraction` [:276](../src/queries.js#L276) | reviews ⋈ users ⋈ titles | Grounding metadata for the prompt |

**Parameter binding is universal**, including the `ILIKE` search, which concatenates only inside
SQL: `t.name ILIKE '%' || $2 || '%'`. Optional filters use the `($1::text IS NULL OR …)` idiom so
one prepared statement serves every filter combination.

### 4.3 Write path — `insertReviewWithTags()` ([queries.js:299](../src/queries.js#L299))

Inside `withTransaction`:

1. `INSERT INTO reviews … RETURNING id, created_at`
2. If tags were supplied:
   ```sql
   INSERT INTO review_tags (review_id, tag_id)
   SELECT $1, tg.id FROM tags tg WHERE tg.slug = ANY($2::text[])
   ON CONFLICT DO NOTHING
   ```
   Slugs are resolved to ids **in the database**. An unknown slug is simply not returned by the
   join, so a bad tag can neither break the insert nor invent a row.
3. `INSERT INTO ai_extractions (review_id, status) VALUES ($1, 'pending')`

Rollback on any throw; the review, its junction rows, and its extraction placeholder are
all-or-nothing.

### 4.4 Extraction writes

- `markExtractionRunning` [:332](../src/queries.js#L332) — `status='running'`, clears `error`.
- `saveExtraction` [:339](../src/queries.js#L339) — one `UPDATE` setting every derived column plus
  `raw_json` (the full validated object) and `completed_at`, then the **same slug-resolving
  insert** as §4.3 for the model's tags. Note these are two statements, **not** in a transaction.
- `failExtraction` [:370](../src/queries.js#L370) — `status='failed'`, `error` truncated to 500
  chars.

## 5. Background queue

### 5.1 `enqueue(job, callback)` ([queue.js:41](../src/lib/queue.js#L41))

```
enqueue(job, cb)
  ├─ job not a function → queueMicrotask(() => cb(TypeError)) ; return
  ├─ queue.push({job, cb}) ; stats.queued++
  └─ if (!draining) { draining = true ; setImmediate(drain) }
```

`queueMicrotask` for the argument error is deliberate: a callback that fires synchronously in one
branch and asynchronously in another makes every call site unreasonable. `setImmediate` for the
start means `enqueue()` always returns before any job runs, so a request handler is never blocked.

### 5.2 `drain()` ([queue.js:66](../src/lib/queue.js#L66))

```
shift → empty? draining = false ; return
      → await job()
          ok   → stats.completed++ ; cb(null, value)
          throw→ stats.failed++    ; cb(err)
      → setImmediate(drain)      // yield: poll phase runs before the next job
```

A throwing job cannot stop the worker. The `setImmediate` tail is what lets HTTP be served
between jobs.

### 5.3 `enqueueAsync` ([queue.js:64](../src/lib/queue.js#L64))

`promisify(enqueue)` — the identical job, delivered as a promise. `promisify()`
([promisify.js:22](../src/lib/promisify.js#L22)) appends an error-first callback to the argument
list and maps its two outcomes onto `resolve`/`reject`.

**Counter semantics:** `stats.queued` is a lifetime total and never decrements; `pending()` is the
live queue length. `stats.completed + stats.failed + pending()` equals `stats.queued` only while
no job is mid-flight.

### 5.4 `runExtraction(reviewId)` ([extraction.js:22](../src/extraction.js#L22))

```
markExtractionRunning(id)
getReviewForExtraction(id) → null ? throw          ← outside the inner try/catch
getTagSlugs()                                       ← 60 s in-process cache
try   { extractReview(review, slugs) → saveExtraction(id, model, data) → return data }
catch { failExtraction(id, err.message) ; rethrow }
```

The "review no longer exists" throw is *outside* the try, so it propagates without writing a
`failed` status — correct, because there is no row left to write to.

Two entry points, one job:
- `scheduleExtraction(id)` [:43](../src/extraction.js#L43) — callback style, errors logged only,
  because the HTTP response has already been sent.
- `extractAndWait(id)` [:55](../src/extraction.js#L55) — promise style, errors reach the client.

## 6. Model interface

### 6.1 Request construction ([prompt.js:80](../src/ai/prompt.js#L80))

`buildContents(review)` returns a three-message array:

1. `user` — the few-shot input (a deliberately *mixed* review, the case models most often round to
   "positive")
2. `model` — the few-shot output, `JSON.stringify` of a complete record
3. `user` — the grounding tag plus the real review:
   ```
   <work kind="movie" name="…" creator="…" year="2016" />
   <review_text>
   …sanitised body…
   </review_text>
   ```

`sanitise()` [:101](../src/ai/prompt.js#L101) replaces every `<` and `>` with a space and
truncates to 4000 chars, so review text cannot close its own delimiter. `escapeAttr()`
[:105](../src/ai/prompt.js#L105) replaces `"` with `'` in metadata and truncates to 120 chars.

The system instruction states the role, a four-step numbered procedure, and six negative
constraints — the last of which declares that everything inside `<review_text>` is data written by
a member of the public and is never an instruction.

**The reviewer's own rating is fetched by `getReviewForExtraction` but never placed in the
prompt.** That is what makes `rating_guess` an independent signal (PRD G4/FR-16).

### 6.2 Decoding parameters ([gemini.js:18](../src/ai/gemini.js#L18))

| Parameter | Value | Reason |
|---|---|---|
| `responseMimeType` | `application/json` | JSON mode; no prose wrapper, no markdown fence |
| `responseSchema` | `buildResponseSchema(tagSlugs)` | Constrains decoding to exactly this shape |
| `temperature` / `topP` | `0.2` / `0.9` | Extraction should be reproducible |
| `maxOutputTokens` | `800` | The record is small |
| `thinkingConfig.thinkingBudget` | `0` | Keeps the background job fast |

Model: `GEMINI_MODEL` or `gemini-2.5-flash`.

Failure modes, each thrown with a specific message: empty response (reports `finishReason`),
unparseable JSON (includes the first 200 chars), validation failure (includes the problem list).

### 6.3 Response schema ([schema.js:20](../src/ai/schema.js#L20))

All eight fields are `required`; `propertyOrdering` fixes emission order so outputs are stable and
diffable. `sentiment` and `spoiler_risk` are enums. **`tags.items.enum` is `tagSlugs`, passed in
from the live `tags` table** — the model cannot name a tag that does not exist. Field semantics
live in the schema's `description` strings, and the prompt does not repeat them.

### 6.4 Offline fallback ([gemini.js:71](../src/ai/gemini.js#L71))

Selected at module load when `GEMINI_API_KEY` is absent. Counts positive and negative keyword hits,
derives `score = clamp(5 + good − bad, 1, 10)`, takes the first sentence as the summary, sets
`spoiler_risk` from a `/ending|twist|dies|reveal/` test, and picks up to two tags that exist in the
vocabulary. Stored with `model = 'offline-fallback'` so it is never mistaken for a real
extraction. It runs through the identical write path — but note it bypasses `validateExtraction`,
being constructed in-shape.

## 7. Front end

### 7.1 State and rendering

One module-scope `const state` ([app.js:18](../public/app.js#L18)) holds `users`, `tags`, `titles`,
`activity`, `kind`, `search`, `activeTag`, `detail`, `aiEnabled`, and `draft` (`{rating, tags:Set}`).

`scheduleRender(name, fn)` ([scheduler.js:33](../public/lib/scheduler.js#L33)) keys pending
renders by region name in a `Map`, so two updates to the same region within one task collapse to
the last. The flush is `queueMicrotask` → `requestAnimationFrame`: the microtask runs as the
current task's stack unwinds, and the DOM write lands immediately before the next paint. `boot()`
issues four render calls that become one frame.

`esc()` ([app.js:492](../public/app.js#L492)) escapes `& < > " '`. Every user-supplied and
model-supplied text field interpolated into `innerHTML` passes through it (review body,
display name, username, tag labels, headline, summary, sentiment, spoiler risk). The
interpolations that do not are numeric ids, ratings and counts, plus `kind` and `cover_emoji`,
which are reference data no API endpoint can write. `class="sentiment ${r.ai_sentiment}"`
([app.js:329](../public/app.js#L329)) interpolates unescaped into an attribute, and is safe only
because the column is `CHECK`-constrained to three literals.

### 7.2 Polling ([scheduler.js:63](../public/lib/scheduler.js#L63))

```
poll(check, { attempts: 20, startMs: 700, growth: 1.15 })
```
First attempt at 700 ms; after each unsuccessful attempt `delay = round(delay × 1.15)` and the
next is scheduled — **only once the previous response has arrived**, which makes overlapping
requests structurally impossible in a way `setInterval` cannot be. Total budget ≈ **71.7 s** over
20 attempts (700 ms → ~9.9 s final gap), plus request time.

- `check()` resolving truthy → resolve with that value
- `check()` throwing → **reject** (the poll aborts; one failed request ends the watch)
- budget exhausted → **resolve `null`**

### 7.3 Post-and-watch ([app.js:395](../public/app.js#L395))

`submitReview` → `POST /api/reviews` → `refreshDetail()` (the review is visible immediately,
marked pending) → `watchExtraction(id)` polls `GET …/extraction` until `done` or `failed` →
`refreshDetail()` + `refreshActivity()` → toast.

`onRerunClick` ([app.js:445](../public/app.js#L445)) uses the awaited endpoint instead, so there is
nothing to poll for.

### 7.4 The two HTTP styles ([http.js](../public/lib/http.js))

`requestJSON(url, options)` — promise; sets JSON headers, `JSON.stringify`s `options.body`,
tolerates a non-JSON error body, and **rejects** on non-2xx with `payload.error` so network and
application failures share one catch. Used by every multi-step flow.

`getJSON(url, cb)` — the callback twin, built on the promise one. Used in exactly one place,
`refreshActivity()` ([app.js:473](../public/app.js#L473)): nothing to compose, nobody waiting.

## 8. Deliberate patterns

These look like cleanup opportunities and are not. See [../CLAUDE.md](../CLAUDE.md).

| Pattern | Where | Why it must stay |
|---|---|---|
| Functions used above their declarations | `queries.js` export map, `server.js` route table, `app.js` `boot()` | Function declarations are hoisted **with their bodies**; a `const` arrow equivalent sits in the temporal dead zone and would throw at load. The file can therefore read entry-point-first. |
| Duplicated callback + promise APIs | `queue.js`, `promisify.js`, `http.js` | Neither half is dead code: fire-and-forget uses one, the awaited re-run path uses the other. |
| `setImmediate` between jobs | `queue.js` drain tail | Yields the poll phase; a `while` loop would starve HTTP. |
| `queueMicrotask` for the argument error | `queue.js` | Never call back synchronously. |
| Self join and `LEFT JOIN LATERAL` | `findRatingDisagreements`, `listCritics` | Chosen for the feature; not to be flattened into window functions or extra round trips. |

## 9. Known gaps

Concrete, reproducible, and accepted for v1.

| # | Gap | Detail |
|---|---|---|
| 1 | **Jobs are lost on restart** | The queue is a module-scope array. A review committed before a crash keeps `status='pending'` forever; nothing sweeps it at boot. The re-run endpoint is the only remedy, and only if someone notices. |
| 2 | **Most seeded reviews have no extraction row** | [db/seed.sql](../db/seed.sql) inserts `ai_extractions` for only 3 of the seeded reviews. For the rest, `GET …/extraction` 404s **and** a re-run's `UPDATE … WHERE review_id = $1` matches 0 rows — so the extraction is computed, the row is silently not written, the model's tags *are* still inserted into `review_tags`, and the caller receives the data as if it had been stored. |
| 3 | **`npm run db:reset` does nothing extra** | It passes `--reset`, but [db/setup.js](../db/setup.js) only recognises `--schema-only`, so it is identical to `db:setup` (which is already destructive). |
| 4 | **Polling gives up silently** | `poll()` resolves `null` after ~72 s; `watchExtraction` then refreshes but shows no toast at all, so a slow extraction looks like nothing happened. |
| 5 | **`saveExtraction` is not transactional** | The row `UPDATE` and the tag `INSERT` are two statements. A failure between them leaves a `done` extraction with no model-proposed tags. |
| 6 | **Error messages leak** | `handleError` ([server.js:207](../src/server.js#L207)) returns `err.message` with a 500, which can surface driver internals. |
| 7 | **No rate limiting** | `POST /api/reviews/:id/extraction` enqueues real model work per call, unauthenticated and unbounded. |
| 8 | **No auth** | `userId` is taken from the request body; any caller may post as any critic. |
| 9 | **No pagination** | Every list endpoint returns its full result set (`/api/disagreements` is the only one with a `LIMIT`). |
| 10 | **Tag cache is per-process and 60 s stale** | A newly added tag is invisible to the model's enum for up to a minute. |
| 11 | **`ssl: { rejectUnauthorized: false }`** | Set for every non-localhost `DATABASE_URL` ([db.js:19](../src/db.js#L19)); encrypts but does not authenticate the server. |
| 12 | **No tests** | There is no test runner in the project; every acceptance criterion in [PRD.md](PRD.md) §8 is currently verified by hand. |
