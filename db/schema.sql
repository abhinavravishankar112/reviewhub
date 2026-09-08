-- ============================================================================
-- ReviewHub — relational schema
--
-- CONCEPT: Relational schema design with PK/FK
--   * Every table has a surrogate PRIMARY KEY (identity column).
--   * Every relationship is enforced by a FOREIGN KEY, with an explicit
--     ON DELETE rule chosen per relationship (CASCADE for owned children,
--     RESTRICT for reference data that must not disappear underneath rows).
--   * Many-to-many (reviews <-> tags) is modelled with a junction table whose
--     PRIMARY KEY is the composite of the two foreign keys, which makes the
--     pairing unique for free.
--   * Business rules live in the database as CHECK / UNIQUE constraints, not
--     only in JavaScript, so bad rows cannot exist even if the API has a bug.
-- ============================================================================

DROP TABLE IF EXISTS ai_extractions CASCADE;
DROP TABLE IF EXISTS review_tags     CASCADE;
DROP TABLE IF EXISTS reviews         CASCADE;
DROP TABLE IF EXISTS tags            CASCADE;
DROP TABLE IF EXISTS titles          CASCADE;
DROP TABLE IF EXISTS users           CASCADE;

-- ---------------------------------------------------------------------------
-- users — a person who writes reviews. Parent of `reviews`.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username     TEXT        NOT NULL UNIQUE,
    display_name TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9_]{3,24}$')
);

-- ---------------------------------------------------------------------------
-- titles — the thing being reviewed: one row per movie or book.
-- `kind` is constrained so the table can hold both without a second table.
-- ---------------------------------------------------------------------------
CREATE TABLE titles (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind         TEXT NOT NULL,
    name         TEXT NOT NULL,
    creator      TEXT NOT NULL,              -- director (movie) / author (book)
    release_year INTEGER,
    cover_emoji  TEXT NOT NULL DEFAULT '🎬',
    blurb        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT titles_kind_allowed CHECK (kind IN ('movie', 'book')),
    CONSTRAINT titles_year_sane    CHECK (release_year IS NULL
                                          OR release_year BETWEEN 1400 AND 2100),
    -- The same name can exist as both a movie and a book, so uniqueness is on
    -- the triple, not on the name alone.
    CONSTRAINT titles_unique_work  UNIQUE (kind, name, release_year)
);

-- ---------------------------------------------------------------------------
-- tags — small controlled vocabulary ("slow-burn", "great-cast", ...).
-- Reference data: a tag may not be deleted while reviews still point at it,
-- so the junction table uses ON DELETE RESTRICT for this side.
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug  TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,

    CONSTRAINT tags_slug_format CHECK (slug ~ '^[a-z0-9-]{2,32}$')
);

-- ---------------------------------------------------------------------------
-- reviews — the fact table. Two FOREIGN KEYs make it the join point between
-- users and titles; the UNIQUE pair stops one user reviewing one title twice.
-- ---------------------------------------------------------------------------
CREATE TABLE reviews (
    id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    INTEGER     NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
    title_id   INTEGER     NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
    rating     INTEGER     NOT NULL,
    body       TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT reviews_rating_range CHECK (rating BETWEEN 1 AND 10),
    CONSTRAINT reviews_body_length  CHECK (char_length(body) BETWEEN 15 AND 4000),
    CONSTRAINT reviews_one_per_user UNIQUE (user_id, title_id)
);

-- FK columns are indexed by hand: Postgres indexes the PRIMARY KEY and UNIQUE
-- constraints automatically but NOT the referencing side of a FOREIGN KEY,
-- and every JOIN in src/queries.js drives through these two columns.
CREATE INDEX reviews_user_id_idx  ON reviews (user_id);
CREATE INDEX reviews_title_id_idx ON reviews (title_id);

-- ---------------------------------------------------------------------------
-- review_tags — junction table resolving the many-to-many between reviews
-- and tags. Composite PRIMARY KEY (review_id, tag_id) = the pair is the row's
-- identity, so the same tag cannot be attached to the same review twice.
-- ---------------------------------------------------------------------------
CREATE TABLE review_tags (
    review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    tag_id    INTEGER NOT NULL REFERENCES tags(id)    ON DELETE RESTRICT,

    PRIMARY KEY (review_id, tag_id)
);

CREATE INDEX review_tags_tag_id_idx ON review_tags (tag_id);

-- ---------------------------------------------------------------------------
-- ai_extractions — what the model returned for one review.
-- One-to-one with reviews, enforced by a UNIQUE FOREIGN KEY column.
-- `status` tracks the background job (see src/lib/queue.js).
-- ---------------------------------------------------------------------------
CREATE TABLE ai_extractions (
    id          INTEGER     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    review_id   INTEGER     NOT NULL UNIQUE REFERENCES reviews(id) ON DELETE CASCADE,
    status      TEXT        NOT NULL DEFAULT 'pending',
    model       TEXT,
    headline    TEXT,
    summary     TEXT,
    sentiment   TEXT,
    rating_guess INTEGER,
    spoiler_risk TEXT,
    raw_json    JSONB,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT ai_status_allowed    CHECK (status IN ('pending','running','done','failed')),
    CONSTRAINT ai_sentiment_allowed CHECK (sentiment IS NULL
                                    OR sentiment IN ('positive','mixed','negative')),
    CONSTRAINT ai_spoiler_allowed   CHECK (spoiler_risk IS NULL
                                    OR spoiler_risk IN ('none','mild','heavy')),
    CONSTRAINT ai_rating_range      CHECK (rating_guess IS NULL
                                    OR rating_guess BETWEEN 1 AND 10)
);

CREATE INDEX ai_extractions_status_idx ON ai_extractions (status);
