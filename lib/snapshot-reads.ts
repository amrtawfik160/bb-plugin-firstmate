export function createSnapshotReads<T>(options: {
  concurrency: number;
  signal: AbortSignal;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const pending = new Map<string, Promise<T>>();
  const cached = new Map<string, { value: T; expiresAt: number }>();
  const queue: Array<() => void> = [];
  let active = 0;
  let generation = 0;

  function drain() {
    while (active < options.concurrency && queue.length > 0) queue.shift()!();
  }

  return {
    invalidate() {
      generation++;
      cached.clear();
    },
    read(key: string, build: () => Promise<T>, cacheMs = 0): Promise<T> {
      options.signal.throwIfAborted();
      const entry = cached.get(key);
      if (cacheMs > 0 && entry && entry.expiresAt > now()) return Promise.resolve(entry.value);
      const existing = pending.get(key);
      if (existing) return existing;
      const startedGeneration = generation;
      const result = new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(options.signal.reason);
        options.signal.addEventListener("abort", onAbort, { once: true });
        queue.push(() => {
          if (options.signal.aborted) {
            options.signal.removeEventListener("abort", onAbort);
            reject(options.signal.reason);
            return;
          }
          active++;
          Promise.resolve().then(build).then(value => {
            if (cacheMs > 0 && startedGeneration === generation && !options.signal.aborted) {
              cached.delete(key);
              cached.set(key, { value, expiresAt: now() + cacheMs });
              while (cached.size > 32) cached.delete(cached.keys().next().value!);
            }
            resolve(value);
          }, reject).finally(() => {
            options.signal.removeEventListener("abort", onAbort);
            active--;
            drain();
          });
        });
      });
      pending.set(key, result);
      void result.finally(() => {
        if (pending.get(key) === result) pending.delete(key);
      }).catch(() => {});
      drain();
      return result;
    },
  };
}
