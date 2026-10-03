export function createFleetRefresh(run: () => Promise<void>, intervalMs = 5000) {
  let disposed = false;
  let inFlight = false;
  let pending = false;
  let lastStartedAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    if (disposed || inFlight || timer !== undefined || !pending) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed) return;
      pending = false;
      inFlight = true;
      lastStartedAt = Date.now();
      void run().catch(() => {}).finally(() => {
        inFlight = false;
        schedule();
      });
    }, Math.max(0, intervalMs - (Date.now() - lastStartedAt)));
  }

  return {
    refresh() {
      pending = true;
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
