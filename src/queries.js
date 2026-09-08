// ============================================================================
// Every SQL statement the app runs, in one file.
//
// CONCEPT: SQL JOINs — this file uses INNER JOIN, LEFT JOIN, a junction-table
// JOIN across a many-to-many, and a SELF JOIN, each because the feature needs
// it rather than for display.
//
// CONCEPT: Hoisting — the exported map below is written *above* the function
// declarations it names. That works because function declarations are hoisted:
// the whole binding, name and body, is created when the module scope is set up,
// before any line runs. Rewriting these as `const listTitles = () => {}` would
// throw a ReferenceError here, because `const` bindings are hoisted into the
// scope but stay in the temporal dead zone until their line executes.
// ============================================================================
import { query, withTransaction } from './db.js';

export const queries = {
  listTitles,
  getTitle,
  listReviewsForTitle,
  listCritics,
  listTagCloud,
  listReviewsByTag,
  findRatingDisagreements,
  getExtraction,
  getReviewForExtraction,
  insertReviewWithTags,
  markExtractionRunning,
  saveExtraction,
  failExtraction,
  listRecentActivity,
};

// ---------------------------------------------------------------------------
// LEFT JOIN + aggregate.
// A LEFT JOIN is required here: a title with no reviews yet must still appear
// in the catalogue, with a null average and a count of 0. An INNER JOIN would
// silently drop it.
// ---------------------------------------------------------------------------
async function listTitles({ kind = null, search = null } = {}) {
  const { rows } = await query(
    `
    SELECT  t.id,
            t.kind,
            t.name,
            t.creator,
            t.release_year,
            t.cover_emoji,
            t.blurb,
            COUNT(r.id)                      AS review_count,
            ROUND(AVG(r.rating)::numeric, 1) AS avg_rating
    FROM titles t
    LEFT JOIN reviews r ON r.title_id = t.id
    WHERE ($1::text IS NULL OR t.kind = $1)
      AND ($2::text IS NULL OR t.name ILIKE '%' || $2 || '%'
                            OR t.creator ILIKE '%' || $2 || '%')
    GROUP BY t.id
    ORDER BY COUNT(r.id) DESC, t.name ASC
    `,
    [kind, search]
  );
  return rows;
}

async function getTitle(titleId) {
  const { rows } = await query(
    `
    SELECT  t.*,
            COUNT(r.id)                      AS review_count,
            ROUND(AVG(r.rating)::numeric, 1) AS avg_rating
    FROM titles t
    LEFT JOIN reviews r ON r.title_id = t.id
    WHERE t.id = $1
    GROUP BY t.id
    `,
    [titleId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Four-table read: INNER JOIN for the author (a review without a user is
// impossible, so INNER is the honest join), LEFT JOIN for the AI extraction
// (may not exist yet, or may have failed), and a LEFT JOIN pair through the
// junction table to collect the tags.
//
// array_agg(... ) FILTER (WHERE ...) collapses the extra rows the tag join
// produces back into one row per review with an array of tags, instead of
// running a second query per review.
// ---------------------------------------------------------------------------
async function listReviewsForTitle(titleId) {
  const { rows } = await query(
    `
    SELECT  r.id,
            r.rating,
            r.body,
            r.created_at,
            u.username,
            u.display_name,
            x.status      AS ai_status,
            x.headline    AS ai_headline,
            x.summary     AS ai_summary,
            x.sentiment   AS ai_sentiment,
            x.rating_guess AS ai_rating_guess,
            x.spoiler_risk AS ai_spoiler_risk,
            COALESCE(
              array_agg(tg.label ORDER BY tg.label) FILTER (WHERE tg.id IS NOT NULL),
              '{}'
            ) AS tags
    FROM reviews r
    INNER JOIN users u          ON u.id = r.user_id
    LEFT  JOIN ai_extractions x ON x.review_id = r.id
    LEFT  JOIN review_tags rt   ON rt.review_id = r.id
    LEFT  JOIN tags tg          ON tg.id = rt.tag_id
    WHERE r.title_id = $1
    GROUP BY r.id, u.username, u.display_name,
             x.status, x.headline, x.summary, x.sentiment,
             x.rating_guess, x.spoiler_risk
    ORDER BY r.created_at DESC
    `,
    [titleId]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Leaderboard. INNER JOIN users -> reviews (a critic with no reviews is not a
// critic), then a LEFT JOIN LATERAL to pull each critic's highest-rated title
// without a second round trip.
// ---------------------------------------------------------------------------
async function listCritics() {
  const { rows } = await query(
    `
    SELECT  u.id,
            u.username,
            u.display_name,
            COUNT(r.id)                      AS review_count,
            ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
            fav.name                         AS favourite_title,
            fav.cover_emoji                  AS favourite_emoji
    FROM users u
    INNER JOIN reviews r ON r.user_id = u.id
    LEFT JOIN LATERAL (
        SELECT t.name, t.cover_emoji
        FROM reviews r2
        INNER JOIN titles t ON t.id = r2.title_id
        WHERE r2.user_id = u.id
        ORDER BY r2.rating DESC, r2.created_at ASC
        LIMIT 1
    ) AS fav ON TRUE
    GROUP BY u.id, fav.name, fav.cover_emoji
    ORDER BY COUNT(r.id) DESC, u.display_name ASC
    `
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Many-to-many traversal: tags -> review_tags -> reviews. LEFT JOIN keeps tags
// that nobody has used yet, which is what makes the count meaningful.
// ---------------------------------------------------------------------------
async function listTagCloud() {
  const { rows } = await query(
    `
    SELECT  tg.id,
            tg.slug,
            tg.label,
            COUNT(rt.review_id) AS use_count
    FROM tags tg
    LEFT JOIN review_tags rt ON rt.tag_id = tg.id
    GROUP BY tg.id
    ORDER BY COUNT(rt.review_id) DESC, tg.label ASC
    `
  );
  return rows;
}

// Five tables in one statement, all INNER: we only want reviews that really
// carry this tag, and each of those necessarily has an author and a title.
async function listReviewsByTag(slug) {
  const { rows } = await query(
    `
    SELECT  r.id,
            r.rating,
            LEFT(r.body, 240) AS excerpt,
            u.display_name,
            t.name  AS title_name,
            t.kind  AS title_kind,
            t.cover_emoji,
            tg.label AS tag_label
    FROM tags tg
    INNER JOIN review_tags rt ON rt.tag_id   = tg.id
    INNER JOIN reviews r      ON r.id        = rt.review_id
    INNER JOIN users u        ON u.id        = r.user_id
    INNER JOIN titles t       ON t.id        = r.title_id
    WHERE tg.slug = $1
    ORDER BY r.rating DESC
    `,
    [slug]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// SELF JOIN: `reviews` joined to itself to find two different people who
// reviewed the same title, so the app can show where critics disagree most.
// `a.user_id < b.user_id` keeps one row per pair instead of both directions
// (and, as a side effect, excludes a review pairing with itself).
// ---------------------------------------------------------------------------
async function findRatingDisagreements(minGap = 2) {
  const { rows } = await query(
    `
    SELECT  t.name        AS title_name,
            t.cover_emoji,
            ua.display_name AS critic_a,
            a.rating        AS rating_a,
            ub.display_name AS critic_b,
            b.rating        AS rating_b,
            ABS(a.rating - b.rating) AS gap
    FROM reviews a
    INNER JOIN reviews b ON b.title_id = a.title_id
                        AND a.user_id  < b.user_id
    INNER JOIN titles t  ON t.id = a.title_id
    INNER JOIN users ua  ON ua.id = a.user_id
    INNER JOIN users ub  ON ub.id = b.user_id
    WHERE ABS(a.rating - b.rating) >= $1
    ORDER BY ABS(a.rating - b.rating) DESC
    LIMIT 10
    `,
    [minGap]
  );
  return rows;
}

async function listRecentActivity(limit = 8) {
  const { rows } = await query(
    `
    SELECT  r.id,
            r.rating,
            r.created_at,
            u.display_name,
            t.name AS title_name,
            t.cover_emoji,
            x.status AS ai_status
    FROM reviews r
    INNER JOIN users u          ON u.id = r.user_id
    INNER JOIN titles t         ON t.id = r.title_id
    LEFT  JOIN ai_extractions x ON x.review_id = r.id
    ORDER BY r.created_at DESC
    LIMIT $1
    `,
    [limit]
  );
  return rows;
}

// The extraction row plus the review it belongs to — one INNER JOIN instead of
// two queries, used by the polling endpoint.
async function getExtraction(reviewId) {
  const { rows } = await query(
    `
    SELECT  x.status, x.model, x.headline, x.summary, x.sentiment,
            x.rating_guess, x.spoiler_risk, x.error, x.completed_at,
            r.rating AS user_rating
    FROM ai_extractions x
    INNER JOIN reviews r ON r.id = x.review_id
    WHERE x.review_id = $1
    `,
    [reviewId]
  );
  return rows[0] ?? null;
}

// Everything the model needs about one review, gathered by joining outwards
// from the review to its author and its title.
async function getReviewForExtraction(reviewId) {
  const { rows } = await query(
    `
    SELECT  r.id, r.body, r.rating,
            u.display_name AS author,
            t.name  AS title_name,
            t.kind  AS title_kind,
            t.creator,
            t.release_year
    FROM reviews r
    INNER JOIN users u  ON u.id = r.user_id
    INNER JOIN titles t ON t.id = r.title_id
    WHERE r.id = $1
    `,
    [reviewId]
  );
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Write path. Three tables in one transaction: the review, its junction rows,
// and the placeholder extraction the background worker will fill in.
// ---------------------------------------------------------------------------
async function insertReviewWithTags({ userId, titleId, rating, body, tagSlugs = [] }) {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO reviews (user_id, title_id, rating, body)
       VALUES ($1, $2, $3, $4)
       RETURNING id, created_at`,
      [userId, titleId, rating, body]
    );
    const review = inserted.rows[0];

    if (tagSlugs.length > 0) {
      // Resolve slugs to ids inside the database. Any slug that is not real is
      // simply not returned by the JOIN, so a bad tag cannot break the insert
      // and cannot invent a row either.
      await client.query(
        `INSERT INTO review_tags (review_id, tag_id)
         SELECT $1, tg.id
         FROM tags tg
         WHERE tg.slug = ANY($2::text[])
         ON CONFLICT DO NOTHING`,
        [review.id, tagSlugs]
      );
    }

    await client.query(
      `INSERT INTO ai_extractions (review_id, status) VALUES ($1, 'pending')`,
      [review.id]
    );

    return review;
  });
}

async function markExtractionRunning(reviewId) {
  await query(
    `UPDATE ai_extractions SET status = 'running', error = NULL WHERE review_id = $1`,
    [reviewId]
  );
}

async function saveExtraction(reviewId, model, data) {
  await query(
    `UPDATE ai_extractions
     SET status = 'done', model = $2, headline = $3, summary = $4,
         sentiment = $5, rating_guess = $6, spoiler_risk = $7,
         raw_json = $8, error = NULL, completed_at = now()
     WHERE review_id = $1`,
    [
      reviewId,
      model,
      data.headline,
      data.summary,
      data.sentiment,
      data.rating_guess,
      data.spoiler_risk,
      JSON.stringify(data),
    ]
  );

  // The model also proposes tags. Same slug-resolving JOIN as above: only
  // slugs that exist in the controlled vocabulary become rows.
  if (Array.isArray(data.tags) && data.tags.length > 0) {
    await query(
      `INSERT INTO review_tags (review_id, tag_id)
       SELECT $1, tg.id FROM tags tg WHERE tg.slug = ANY($2::text[])
       ON CONFLICT DO NOTHING`,
      [reviewId, data.tags]
    );
  }
}

async function failExtraction(reviewId, message) {
  await query(
    `UPDATE ai_extractions
     SET status = 'failed', error = $2, completed_at = now()
     WHERE review_id = $1`,
    [reviewId, String(message).slice(0, 500)]
  );
}
