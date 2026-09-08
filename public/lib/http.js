// ============================================================================
// CONCEPT: Promises vs callbacks — the same request, both ways.
//
// getJSON(url, callback) is the classic Node-style form: the caller passes a
// function in, and the transport decides when to call it, with an error as the
// first argument. It is fine for a single fire-and-forget request, and it is
// what the sidebar's activity refresh uses.
//
// requestJSON(url) returns a promise instead, so the caller keeps control: it
// can await it, run several in parallel with Promise.all, or let a rejection
// fall through to a try/catch. Every multi-step flow in app.js uses this form,
// because callbacks compose by nesting and promises compose by sequencing:
//
//   callbacks                          promises
//   ---------                          --------
//   getJSON(a, (e, r1) => {            const r1 = await requestJSON(a);
//     if (e) return fail(e);           const r2 = await requestJSON(b(r1));
//     getJSON(b(r1), (e, r2) => {      // errors land in one catch
//       if (e) return fail(e);
//       ...                            // one level of indentation, always
//     });
//   });
// ============================================================================

export async function requestJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Rejecting means the caller's try/catch sees this the same way it would
    // see a network failure — one error path instead of two.
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return payload;
}

// The callback-shaped twin, built on the promise one. Note the deliberate
// `setTimeout(..., 0)` free design: fetch is already asynchronous, so the
// callback can never fire before this function returns.
export function getJSON(url, callback) {
  requestJSON(url).then(
    (data) => callback(null, data),
    (err) => callback(err)
  );
}
