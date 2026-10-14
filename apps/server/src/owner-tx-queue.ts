/**
 * One in-process queue for all owner/listing-role sends so cast and viem
 * never race the same nonce (production: LOK_LISTING_KEY only).
 */

let queue: Promise<unknown> = Promise.resolve();

/** Serialize work that signs with the server owner/listing key. */
export function withOwnerKeyQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Test helper: drain the queue (waits for in-flight work). */
export function ownerKeyQueueTail(): Promise<void> {
  return queue.then(
    () => undefined,
    () => undefined,
  );
}
