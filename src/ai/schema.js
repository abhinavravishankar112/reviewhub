// ============================================================================
// CONCEPT: Structured outputs
//
// The model is not asked to "reply with JSON and hope". It is given a response
// schema, and the API is put into JSON mode (responseMimeType), so decoding is
// constrained to that shape: the response is machine-parseable by construction,
// with no prose wrapper, no markdown fence, and no invented fields.
//
// The schema is generated from the database's own tag vocabulary, so the enum
// the model may choose from is exactly the set of `tags.slug` values that
// exist. A tag the model cannot name is a tag it cannot hallucinate.
//
// The schema is a contract, not a guarantee about meaning, so validate()
// re-checks everything the type system cannot: ranges, lengths, and membership.
// ============================================================================

export const SENTIMENTS = ['positive', 'mixed', 'negative'];
export const SPOILER_RISKS = ['none', 'mild', 'heavy'];

export function buildResponseSchema(tagSlugs) {
  return {
    type: 'OBJECT',
    // propertyOrdering makes the model emit fields in a fixed order, which
    // keeps outputs stable and diffable between runs.
    propertyOrdering: [
      'headline', 'summary', 'sentiment', 'rating_guess',
      'spoiler_risk', 'praised', 'criticised', 'tags',
    ],
    properties: {
      headline: {
        type: 'STRING',
        description:
          'A neutral 3-8 word headline capturing the reviewer\'s verdict. No spoilers, no title name, no quotation marks.',
      },
      summary: {
        type: 'STRING',
        description:
          'One or two sentences, max 45 words, restating only opinions the reviewer actually expressed. Third person.',
      },
      sentiment: {
        type: 'STRING',
        enum: SENTIMENTS,
        description: 'Overall stance. Use "mixed" when praise and criticism are balanced.',
      },
      rating_guess: {
        type: 'INTEGER',
        description:
          'The 1-10 score this text implies, judged from the wording alone, ignoring any score the reviewer gave.',
      },
      spoiler_risk: {
        type: 'STRING',
        enum: SPOILER_RISKS,
        description:
          '"heavy" if the review reveals an ending or twist, "mild" if it hints at one, "none" otherwise.',
      },
      praised: {
        type: 'ARRAY',
        description: 'Up to 3 specific things the reviewer liked. Two or three words each.',
        items: { type: 'STRING' },
      },
      criticised: {
        type: 'ARRAY',
        description: 'Up to 3 specific things the reviewer disliked. Empty array if none.',
        items: { type: 'STRING' },
      },
      tags: {
        type: 'ARRAY',
        description:
          'Between 1 and 3 tags from the allowed list that the review genuinely supports. Never guess to fill the list.',
        items: { type: 'STRING', enum: tagSlugs },
      },
    },
    required: [
      'headline', 'summary', 'sentiment', 'rating_guess',
      'spoiler_risk', 'praised', 'criticised', 'tags',
    ],
  };
}

// Second line of defence. The schema shapes the response; this checks that the
// values inside that shape are usable, and that they satisfy the same rules the
// database CHECK constraints enforce, so a bad extraction is rejected here
// rather than blowing up mid-INSERT.
export function validateExtraction(raw, allowedTagSlugs) {
  const problems = [];

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problems: ['response was not a JSON object'] };
  }

  const text = (value, field, max) => {
    if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${field} missing`);
      return '';
    }
    return value.trim().slice(0, max);
  };

  const list = (value, max) =>
    (Array.isArray(value) ? value : [])
      .filter((item) => typeof item === 'string' && item.trim() !== '')
      .map((item) => item.trim().slice(0, 60))
      .slice(0, max);

  const clean = {
    headline: text(raw.headline, 'headline', 80),
    summary: text(raw.summary, 'summary', 400),
    sentiment: SENTIMENTS.includes(raw.sentiment) ? raw.sentiment : null,
    rating_guess: Number.isInteger(raw.rating_guess) ? raw.rating_guess : null,
    spoiler_risk: SPOILER_RISKS.includes(raw.spoiler_risk) ? raw.spoiler_risk : 'none',
    praised: list(raw.praised, 3),
    criticised: list(raw.criticised, 3),
    // Drop anything outside the vocabulary even though the enum should have
    // prevented it — the INSERT ... JOIN tags would drop it anyway, but failing
    // loudly here is more useful than silently losing a tag.
    tags: list(raw.tags, 3).filter((slug) => allowedTagSlugs.includes(slug)),
  };

  if (clean.sentiment === null) problems.push('sentiment not one of ' + SENTIMENTS.join('/'));
  if (clean.rating_guess === null || clean.rating_guess < 1 || clean.rating_guess > 10) {
    problems.push('rating_guess must be an integer 1-10');
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, data: clean };
}
