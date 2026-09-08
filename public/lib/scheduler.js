// ============================================================================
// CONCEPT: JavaScript event loop (browser side)
//
// The browser's loop runs one task at a time: a task (a click handler, a timer
// callback, a network response) runs to completion, then the microtask queue is
// drained *entirely*, then the browser may render. Nothing else can happen
// while a task is on the stack, which is why a long synchronous loop freezes
// scrolling and typing.
//
// Three consequences are used in this app:
//
//   scheduleRender — several state changes usually land in the same task (a
//     response arrives, filters update, a list is replaced). Rendering on each
//     one would touch the DOM several times before a single paint. Coalescing
//     in a microtask collapses that burst into one render, and handing the
//     actual DOM write to requestAnimationFrame puts it immediately before the
//     next paint instead of at some arbitrary point in the task.
//
//   debounce — keystrokes arrive as separate tasks, faster than the search
//     request can finish. A timer is a macrotask: each keystroke cancels the
//     pending one and queues a new one, so only the pause at the end survives.
//
//   poll — a self-rescheduling setTimeout, never setInterval. setInterval keeps
//     queueing callbacks on a fixed cadence whether or not the previous request
//     has come back, so a slow response builds a backlog of overlapping
//     requests. Rescheduling only *after* the response arrived makes overlap
//     structurally impossible.
// ============================================================================

const pendingRenders = new Map();
let flushScheduled = false;

export function scheduleRender(name, renderFn) {
  // Keyed by name: two updates to the same region in one task collapse into
  // the last one rather than both running.
  pendingRenders.set(name, renderFn);

  if (flushScheduled) return;
  flushScheduled = true;

  // Microtask: runs as soon as the current task's stack unwinds, still before
  // the browser gets a chance to paint, so nothing is ever shown half-updated.
  queueMicrotask(() => {
    requestAnimationFrame(() => {
      flushScheduled = false;
      const jobs = [...pendingRenders.values()];
      pendingRenders.clear();
      for (const job of jobs) job();
    });
  });
}

export function debounce(fn, waitMs) {
  let timerId = null;
  return function debounced(...args) {
    clearTimeout(timerId);
    timerId = setTimeout(() => fn.apply(this, args), waitMs);
  };
}

// Polls `check` until it returns a truthy value or the attempt budget runs out.
// The delay grows a little each time, so a slow extraction is not hammered.
export function poll(check, { attempts = 20, startMs = 700, growth = 1.15 } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let delay = startMs;

    const tick = async () => {
      attempt += 1;
      try {
        const result = await check();
        if (result) return resolve(result);
      } catch (err) {
        return reject(err);
      }

      if (attempt >= attempts) return resolve(null);

      delay = Math.round(delay * growth);
      // Only now, with the previous request finished, is the next one queued.
      setTimeout(tick, delay);
    };

    setTimeout(tick, startMs);
  });
}
