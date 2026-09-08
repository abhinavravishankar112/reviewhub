-- Seed data. Child rows resolve their FOREIGN KEYs by sub-SELECT rather than
-- by hard-coded ids, so the file stays correct whatever the identity sequence
-- happens to be.

INSERT INTO users (username, display_name) VALUES
    ('mara_v',    'Mara Vance'),
    ('deniz_k',   'Deniz Kaya'),
    ('jonas_r',   'Jonas Reid'),
    ('priya_s',   'Priya Sharma'),
    ('tom_okafor','Tom Okafor');

INSERT INTO titles (kind, name, creator, release_year, cover_emoji, blurb) VALUES
    ('movie', 'Arrival',              'Denis Villeneuve',  2016, '🛸', 'A linguist is recruited to talk to visitors whose language bends time.'),
    ('movie', 'Parasite',             'Bong Joon-ho',      2019, '🏠', 'One family works its way into another family''s house, and their lives.'),
    ('movie', 'Paddington 2',         'Paul King',         2017, '🐻', 'A bear, a pop-up book, and the most decent prison in cinema.'),
    ('movie', 'Blade Runner 2049',    'Denis Villeneuve',  2017, '🌆', 'A replicant detective finds a memory that should not exist.'),
    ('book',  'Piranesi',             'Susanna Clarke',    2020, '🗝️', 'A man lives in an endless house of statues and tides, and keeps a journal.'),
    ('book',  'The Left Hand of Darkness','Ursula K. Le Guin', 1969, '❄️', 'An envoy crosses ice with a politician on a world without fixed gender.'),
    ('book',  'Project Hail Mary',    'Andy Weir',         2021, '🚀', 'A lone astronaut wakes with amnesia and a very small problem: the sun.'),
    ('book',  'Klara and the Sun',    'Kazuo Ishiguro',    2021, '☀️', 'An artificial friend watches a family from a shop window and then from inside it.');

INSERT INTO tags (slug, label) VALUES
    ('slow-burn',      'Slow burn'),
    ('great-cast',     'Great cast'),
    ('emotional',      'Emotional'),
    ('rewatchable',    'Rewatchable'),
    ('confusing',      'Confusing'),
    ('beautiful',      'Beautiful'),
    ('overrated',      'Overrated'),
    ('page-turner',    'Page turner'),
    ('thought-provoking','Thought provoking'),
    ('cozy',           'Cozy');

INSERT INTO reviews (user_id, title_id, rating, body) VALUES
    ((SELECT id FROM users WHERE username = 'mara_v'),
     (SELECT id FROM titles WHERE name = 'Arrival'),
     9, 'The structure is the point. I spent the first hour thinking it was a quiet alien film and the last twenty minutes rearranging everything I had assumed. Amy Adams carries it without ever raising her voice.'),

    ((SELECT id FROM users WHERE username = 'deniz_k'),
     (SELECT id FROM titles WHERE name = 'Arrival'),
     7, 'Gorgeous and cold. I admired it more than I enjoyed it, and the military subplot deflates every time it appears. Still, the sound design alone is worth it.'),

    ((SELECT id FROM users WHERE username = 'jonas_r'),
     (SELECT id FROM titles WHERE name = 'Parasite'),
     10, 'It changes genre three times and never once loses its footing. The staircases do more storytelling than most scripts manage in two hours.'),

    ((SELECT id FROM users WHERE username = 'mara_v'),
     (SELECT id FROM titles WHERE name = 'Paddington 2'),
     9, 'A film with no cynicism in it at all. I put it on expecting to half-watch and ended up crying at a pop-up book. Hugh Grant is having the time of his life.'),

    ((SELECT id FROM users WHERE username = 'priya_s'),
     (SELECT id FROM titles WHERE name = 'Piranesi'),
     10, 'Short, strange, and completely absorbing. The journal format means you work out the shape of the world about a page before the narrator does, which is a wonderful feeling.'),

    ((SELECT id FROM users WHERE username = 'tom_okafor'),
     (SELECT id FROM titles WHERE name = 'Project Hail Mary'),
     8, 'Enormously fun, and the science actually pays off in the plot instead of decorating it. The dialogue is broad and the flashbacks drag, but I read it in two sittings.'),

    ((SELECT id FROM users WHERE username = 'deniz_k'),
     (SELECT id FROM titles WHERE name = 'The Left Hand of Darkness'),
     9, 'The ice crossing in the back half is one of the great pieces of science fiction writing. The early political chapters are heavy going and I nearly stopped.'),

    ((SELECT id FROM users WHERE username = 'priya_s'),
     (SELECT id FROM titles WHERE name = 'Blade Runner 2049'),
     6, 'Every frame is a painting and every scene is four minutes too long. Beautiful, hollow, and I have no urge to see it again.');

-- Junction rows: (review, tag) pairs. The VALUES list leads the FROM clause so
-- every later JOIN can reference it.
INSERT INTO review_tags (review_id, tag_id)
SELECT r.id, t.id
FROM (VALUES
    ('mara_v',    'Arrival',                   'thought-provoking'),
    ('mara_v',    'Arrival',                   'emotional'),
    ('deniz_k',   'Arrival',                   'beautiful'),
    ('deniz_k',   'Arrival',                   'slow-burn'),
    ('jonas_r',   'Parasite',                  'great-cast'),
    ('jonas_r',   'Parasite',                  'rewatchable'),
    ('mara_v',    'Paddington 2',              'cozy'),
    ('mara_v',    'Paddington 2',              'emotional'),
    ('priya_s',   'Piranesi',                  'beautiful'),
    ('priya_s',   'Piranesi',                  'page-turner'),
    ('tom_okafor','Project Hail Mary',         'page-turner'),
    ('deniz_k',   'The Left Hand of Darkness', 'slow-burn'),
    ('deniz_k',   'The Left Hand of Darkness', 'thought-provoking'),
    ('priya_s',   'Blade Runner 2049',         'beautiful'),
    ('priya_s',   'Blade Runner 2049',         'overrated')
) AS v(username, title_name, tag_slug)
JOIN users   u  ON u.username = v.username
JOIN titles  ti ON ti.name    = v.title_name
JOIN reviews r  ON r.user_id  = u.id AND r.title_id = ti.id
JOIN tags    t  ON t.slug     = v.tag_slug;

-- Pre-computed extractions for a few seeded reviews, so the app has something
-- to show before anyone calls the model.
INSERT INTO ai_extractions (review_id, status, model, headline, summary, sentiment, rating_guess, spoiler_risk, raw_json, completed_at)
SELECT r.id, 'done', 'seed', v.headline, v.summary, v.sentiment, v.rating_guess, v.spoiler_risk,
       jsonb_build_object('source', 'seed'), now()
FROM (VALUES
    ('mara_v',  'Arrival',  'A quiet film that rearranges itself',
      'Praises the non-linear structure and a restrained lead performance; the reveal reframes the whole film.',
      'positive', 9, 'mild'),
    ('deniz_k', 'Arrival',  'Admired more than enjoyed',
      'Finds the film beautiful and sonically impressive but emotionally cool, with a weak military subplot.',
      'mixed', 7, 'none'),
    ('jonas_r', 'Parasite', 'Three genres, no missteps',
      'Highlights confident tonal shifts and visual storytelling through the film''s architecture.',
      'positive', 10, 'none')
) AS v(username, title_name, headline, summary, sentiment, rating_guess, spoiler_risk)
JOIN users   u  ON u.username = v.username
JOIN titles  ti ON ti.name    = v.title_name
JOIN reviews r  ON r.user_id  = u.id AND r.title_id = ti.id;
