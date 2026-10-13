export class ScanCapacityError extends Error {
  constructor() { super("The investigation engine is busy. Please try again shortly."); this.name = "ScanCapacityError"; }
}

/** In-memory capacity only. It never retains token parameters, evidence, or reports. */
export class ScanCapacity {
  private active = 0;
  private explaining = false;
  private waiting: { signal: AbortSignal; grant: () => void; cancel: () => void }[] = [];

  constructor(private readonly maximumScans = 3) {
    if (!Number.isInteger(maximumScans) || maximumScans < 1 || maximumScans > 8) throw new RangeError("Unsupported scan concurrency.");
  }

  enter(): () => void {
    if (this.active >= this.maximumScans) throw new ScanCapacityError();
    this.active++;
    let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }

  async explanation(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (!this.explaining) { this.explaining = true; return this.releaseExplanation(); }
    if (this.waiting.length >= this.maximumScans - 1) throw new ScanCapacityError();
    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        grant: () => { signal.removeEventListener("abort", waiter.cancel); resolve(this.releaseExplanation()); },
        cancel: () => { this.waiting = this.waiting.filter((item) => item !== waiter); signal.removeEventListener("abort", waiter.cancel); reject(signal.reason); },
      };
      this.waiting.push(waiter);
      signal.addEventListener("abort", waiter.cancel, { once: true });
      if (signal.aborted) waiter.cancel();
    });
  }

  private releaseExplanation() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next.grant();
      else this.explaining = false;
    };
  }
}

const capacityGlobal = globalThis as typeof globalThis & { traceforceScanCapacity?: ScanCapacity };
export function getScanCapacity() { return capacityGlobal.traceforceScanCapacity ??= new ScanCapacity(3); }
