// ============================================================================
// CONCEPT: Promises vs callbacks — the bridge between the two styles.
//
// A Node-style callback function has the signature fn(...args, (err, value)).
// A promise-returning function has the signature fn(...args) -> Promise<value>.
// They carry the same information; only the delivery differs:
//
//   callback:  the caller hands control to the callee, which decides when and
//              how often to call back. Errors arrive as a first argument that
//              nothing forces you to check, and composing two async steps means
//              nesting a second callback inside the first.
//
//   promise:   the callee hands a value-shaped object back to the caller, which
//              decides what to do with it. Errors travel the same path as
//              values, so try/catch works, and steps compose with await instead
//              of nesting.
//
// promisify() converts the first into the second, which is why a codebase can
// keep a callback-based core (queue.js) and still be written with async/await
// at the edges (server.js).
// ============================================================================
export function promisify(fn) {
  return function promisified(...args) {
    return new Promise((resolve, reject) => {
      // The executor runs synchronously; `resolve` and `reject` are what turn
      // the callback's two outcomes into the promise's two outcomes.
      fn.call(this, ...args, (err, value) => {
        if (err) reject(err);
        else resolve(value);
      });
    });
  };
}
