/**
 * Fan one synchronous snapshot producer out to any number of live consumers.
 *
 * Snapshot construction can be expensive and blocks the Node event loop. A
 * timer per SSE client multiplies that work and, when construction takes longer
 * than the interval, can starve every other control-plane request. This stream
 * computes once, shares the result, and waits until the completed computation
 * before scheduling the next refresh.
 */
export class SharedSnapshotStream<T> {
  private readonly listeners = new Set<(snapshot: T) => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private latest: T | undefined;
  private hasLatest = false;
  private running = false;

  constructor(
    private readonly build: () => T | Promise<T>,
    private readonly refreshMs: number,
  ) {}

  subscribe(listener: (snapshot: T) => void): () => void {
    this.listeners.add(listener);
    if (this.hasLatest) {
      this.deliver(listener, this.latest as T);
    } else if (!this.running && !this.timer) {
      this.tick();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.latest = undefined;
        this.hasLatest = false;
      }
    };
  }

  private tick(): void {
    this.timer = undefined;
    if (this.running || this.listeners.size === 0) return;
    this.running = true;
    let deferred = false;
    try {
      const result = this.build();
      if (result && typeof (result as Promise<T>).then === "function") {
        deferred = true;
        void Promise.resolve(result)
          .then((snapshot) => this.publish(snapshot))
          .catch(() => {
            // A transient producer failure should not stop later refreshes.
          })
          .finally(() => this.finish());
      } else {
        this.publish(result as T);
      }
    } catch {
      // A transient store read failure must not crash the control plane or
      // permanently disable updates for every connected dashboard.
    } finally {
      if (!deferred) this.finish();
    }
  }

  private publish(snapshot: T): void {
    if (this.listeners.size === 0) return;
    this.latest = snapshot;
    this.hasLatest = true;
    for (const listener of [...this.listeners]) this.deliver(listener, snapshot);
  }

  private finish(): void {
    this.running = false;
    if (this.listeners.size > 0) {
      this.timer = setTimeout(() => this.tick(), Math.max(0, this.refreshMs));
      this.timer.unref?.();
    }
  }

  private deliver(listener: (snapshot: T) => void, snapshot: T): void {
    try {
      listener(snapshot);
    } catch {
      this.listeners.delete(listener);
    }
  }
}
