



export class TextDeltaSmoother {
  private buf = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  
  private emittedTotal = 0;

  constructor(
    private readonly emitDelta: (chunk: string) => void,
    private readonly tickMs: number,
    private readonly minPerTick: number,
    
    private readonly fastPathFirstN: number = 30
  ) {}

  static create(
    emitDelta: (chunk: string) => void,
    opts?: { tickMs?: number; minPerTick?: number; fastPathFirstN?: number }
  ): TextDeltaSmoother {
    
    
    const tickMs = Math.max(4, Math.min(30, opts?.tickMs ?? 10));
    const minPerTick = Math.max(1, Math.min(24, opts?.minPerTick ?? 1));
    
    
    const fastPathFirstN = Math.max(0, opts?.fastPathFirstN ?? 120);
    return new TextDeltaSmoother(emitDelta, tickMs, minPerTick, fastPathFirstN);
  }

  push(rawDelta: string) {
    if (!rawDelta) return;

    
    if (this.emittedTotal < this.fastPathFirstN) {
      const remaining = this.fastPathFirstN - this.emittedTotal;
      if (rawDelta.length <= remaining) {
        this.emitDelta(rawDelta);
        this.emittedTotal += rawDelta.length;
        return;
      }
      
      const direct = rawDelta.slice(0, remaining);
      const rest = rawDelta.slice(remaining);
      this.emitDelta(direct);
      this.emittedTotal += direct.length;
      rawDelta = rest;
      if (!rawDelta) return;
    }

    const wasIdle = !this.timer && this.buf.length === 0;
    this.buf += rawDelta;
    if (wasIdle) {
      this.pump();
    }
    this.ensureTimer();
  }

  private ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this.pump(), this.tickMs);
  }

  private stopTimer() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private pump() {
    if (this.buf.length === 0) {
      this.stopTimer();
      return;
    }
    const len = this.buf.length;
    
    
    
    const adaptive =
      len > 520 ? 24 : len > 220 ? 14 : len > 80 ? 8 : len > 28 ? 5 : this.minPerTick;
    const take = Math.min(len, adaptive);
    const chunk = this.buf.slice(0, take);
    this.buf = this.buf.slice(take);
    this.emitDelta(chunk);
    this.emittedTotal += chunk.length;
  }

  flushSync() {
    this.stopTimer();
    if (!this.buf) return;
    const rest = this.buf;
    this.buf = '';
    this.emitDelta(rest);
    this.emittedTotal += rest.length;
  }

  dispose() {
    this.flushSync();
  }
}
