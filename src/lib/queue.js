// ============================================================================
// A single-worker background job queue.
//
// CONCEPT: JavaScript event loop
// Node runs this whole server on one thread. The event loop cycles through
// phases — timers, pending callbacks, poll (incoming sockets), check
// (setImmediate) — and drains the microtask queue (promise continuations,
// queueMicrotask) completely after each individual task. Anything that runs
// long without yielding therefore blocks *every* HTTP request, because the poll
// phase never gets a turn to read the sockets.
//
// That shapes two decisions here:
//
//   1. Posting a review returns immediately and the Gemini call happens in this
//      queue. The model takes seconds; the HTTP response takes milliseconds.
//      The request handler starts the job and returns, so the loop is free to
//      serve the next request while the job's awaits are pending.
//
//   2. The drain loop schedules the next job with setImmediate rather than
//      looping. setImmediate defers to the check phase, which means the poll
//      phase runs first and queued socket reads are handled *between* jobs. A
//      plain `while (queue.length)` loop would finish the whole backlog before
//      the server answered anyone, even though each job is mostly waiting on
//      the network.
//
// CONCEPT: Promises vs callbacks
// The public API is deliberately offered in both styles:
//   enqueue(job, callback)  — classic error-first callback
//   enqueueAsync(job)       — the same thing as a promise, via promisify()
// server.js uses the callback form for fire-and-forget background work and the
// promise form when a request wants to await the result.
// ============================================================================
import { promisify } from './promisify.js';

const queue = [];
let draining = false;

export const stats = { queued: 0, completed: 0, failed: 0 };

// Node-style: never throws at the caller, always reports through `callback`.
export function enqueue(job, callback = () => {}) {
  if (typeof job !== 'function') {
    // Even an argument error is reported asynchronously. A callback that
    // sometimes fires synchronously and sometimes later ("releasing Zalgo")
    // makes call sites impossible to reason about, so queueMicrotask pushes it
    // onto the microtask queue: it runs after the current call stack unwinds,
    // but before the next timer or I/O event.
    queueMicrotask(() => callback(new TypeError('job must be a function')));
    return;
  }

  queue.push({ job, callback });
  stats.queued += 1;

  if (!draining) {
    draining = true;
    // Start on the next tick of the loop, not inside the caller's stack, so
    // enqueue() always returns instantly to the request handler.
    setImmediate(drain);
  }
}

// The promise-shaped twin. Identical work, different delivery.
export const enqueueAsync = promisify(enqueue);

async function drain() {
  const next = queue.shift();

  if (!next) {
    draining = false;
    return;
  }

  try {
    const value = await next.job();
    stats.completed += 1;
    next.callback(null, value);
  } catch (err) {
    // A failing job must not take the worker down with it: the callback is told
    // and the loop continues to the next job.
    stats.failed += 1;
    next.callback(err);
  }

  // Yield to the event loop before the next job (see the note at the top).
  setImmediate(drain);
}

export function pending() {
  return queue.length;
}
