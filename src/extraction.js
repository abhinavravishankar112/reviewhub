// Ties the three pieces together: pull the review with a JOIN, send it to the
// model under the engineered prompt + response schema, write the structured
// result back. Runs inside the background queue, never inside a request.
import { queries } from './queries.js';
import { extractReview, aiEnabled } from './ai/gemini.js';
import { enqueue, enqueueAsync } from './lib/queue.js';

// The tag vocabulary changes rarely, and it is needed on every extraction to
// build the response schema's enum, so it is cached for a minute.
let tagCache = { slugs: null, at: 0 };
const TAG_TTL_MS = 60_000;

async function getTagSlugs() {
  const now = Date.now();
  if (tagCache.slugs && now - tagCache.at < TAG_TTL_MS) return tagCache.slugs;

  const tags = await queries.listTagCloud();
  tagCache = { slugs: tags.map((t) => t.slug), at: now };
  return tagCache.slugs;
}

async function runExtraction(reviewId) {
  await queries.markExtractionRunning(reviewId);

  const review = await queries.getReviewForExtraction(reviewId);
  if (!review) throw new Error(`review ${reviewId} no longer exists`);

  const tagSlugs = await getTagSlugs();

  try {
    const { model, data } = await extractReview(review, tagSlugs);
    await queries.saveExtraction(reviewId, model, data);
    return data;
  } catch (err) {
    await queries.failExtraction(reviewId, err.message);
    throw err;
  }
}

// Callback style: fire and forget. The request handler that calls this does not
// wait for the result, and errors are logged rather than propagated, because
// there is no longer a request to propagate them to.
export function scheduleExtraction(reviewId) {
  enqueue(
    () => runExtraction(reviewId),
    (err) => {
      if (err) console.error(`[extract] review ${reviewId} failed:`, err.message);
      else console.log(`[extract] review ${reviewId} done`);
    }
  );
}

// Promise style: same queue, same job, but awaited — used by the "re-run"
// endpoint, where the client is waiting for the new record.
export function extractAndWait(reviewId) {
  return enqueueAsync(() => runExtraction(reviewId));
}

export { aiEnabled };
