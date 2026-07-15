export class PlaybackTracker {
  private bytesSent = 0;
  private readonly sampleRate = 8000;

  recordOutboundBytes(byteCount: number): void {
    if (byteCount > 0) {
      this.bytesSent += byteCount;
    }
  }

  getPlayedDurationMs(): number {
    return Math.floor((this.bytesSent / this.sampleRate) * 1000);
  }

  reset(): void {
    this.bytesSent = 0;
  }
}
