// Gemini client. Promise-based end to end: one `await` per call, errors thrown
// rather than passed to a callback (see src/lib/queue.js for the contrast).
//
// If GEMINI_API_KEY is absent the module falls back to a deterministic local
// extractor, so the site still runs — useful offline and in a classroom demo
// where the key is not on the machine.
import { GoogleGenAI } from '@google/genai';
import { buildContents, SYSTEM_INSTRUCTION } from './prompt.js';
import { buildResponseSchema, validateExtraction } from './schema.js';

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const apiKey = process.env.GEMINI_API_KEY;

export const aiEnabled = Boolean(apiKey);

const client = aiEnabled ? new GoogleGenAI({ apiKey }) : null;

export async function extractReview(review, tagSlugs) {
  if (!aiEnabled) {
    return { model: 'offline-fallback', data: offlineExtract(review, tagSlugs) };
  }

  const response = await client.models.generateContent({
    model: MODEL,
    contents: buildContents(review),
    config: {
      systemInstruction: SYSTEM_INSTRUCTION,
      // Structured output: JSON mime type + schema is what forces the response
      // to be exactly this shape.
      responseMimeType: 'application/json',
      responseSchema: buildResponseSchema(tagSlugs),
      // Extraction should be reproducible, so decoding is kept near-greedy.
      temperature: 0.2,
      topP: 0.9,
      maxOutputTokens: 800,
      // No reasoning budget needed for a short extraction; this keeps the
      // background job fast.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error(`model returned no text (finish reason: ${
      response.candidates?.[0]?.finishReason ?? 'unknown'
    })`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`model output was not valid JSON: ${text.slice(0, 200)}`);
  }

  const checked = validateExtraction(parsed, tagSlugs);
  if (!checked.ok) {
    throw new Error(`extraction failed validation: ${checked.problems.join('; ')}`);
  }

  return { model: MODEL, data: checked.data };
}

// ---------------------------------------------------------------------------
// Offline fallback: crude keyword scoring, no network. It exists so the app is
// never broken by a missing key; it is not pretending to be the model.
// ---------------------------------------------------------------------------
const POSITIVE = ['astonishing','gorgeous','beautiful','brilliant','loved','fun','absorbing','great','wonderful','perfect','carries','worth'];
const NEGATIVE = ['hollow','drag','drags','deflates','overrated','boring','cold','repetit','too long','nearly stopped','heavy going','no urge'];

function offlineExtract(review, tagSlugs) {
  const text = review.body.toLowerCase();
  const hits = (words) => words.filter((w) => text.includes(w));

  const good = hits(POSITIVE);
  const bad = hits(NEGATIVE);
  const score = Math.max(1, Math.min(10, 5 + good.length - bad.length));

  let sentiment = 'mixed';
  if (good.length > 0 && bad.length === 0) sentiment = 'positive';
  if (bad.length > good.length) sentiment = 'negative';

  const firstSentence = review.body.split(/(?<=[.!?])\s/)[0] ?? review.body;

  const guessed = ['thought-provoking', 'beautiful', 'slow-burn', 'emotional']
    .filter((slug) => tagSlugs.includes(slug))
    .slice(0, sentiment === 'negative' ? 1 : 2);

  return {
    headline: sentiment === 'negative' ? 'A frustrated verdict' : 'A largely favourable verdict',
    summary: firstSentence.trim().slice(0, 220),
    sentiment,
    rating_guess: score,
    spoiler_risk: /ending|twist|dies|reveal/.test(text) ? 'mild' : 'none',
    praised: good.slice(0, 3),
    criticised: bad.slice(0, 3),
    tags: guessed,
  };
}
