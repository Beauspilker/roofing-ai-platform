import { logInfo, logWarn } from "../logger.js";

const MAX_BUFFERED_CHUNKS = 48;
const MAX_BUFFER_AGE_MS = 3_000;

type BufferedChunk = {
  base64Audio: string;
  receivedAtMs: number;
};

export class GreetingAudioBuffer {
  private chunks: BufferedChunk[] = [];
  private firstChunkAtMs: number | null = null;

  enqueue(base64Audio: string): boolean {
    if (!base64Audio) {
      return false;
    }

    const now = Date.now();
    this.evictExpired(now);

    if (this.chunks.length >= MAX_BUFFERED_CHUNKS) {
      logWarn("greeting_audio_buffer_full", { bufferedChunks: this.chunks.length });
      return false;
    }

    if (this.firstChunkAtMs === null) {
      this.firstChunkAtMs = now;
    }

    this.chunks.push({ base64Audio, receivedAtMs: now });
    return true;
  }

  flush(forward: (base64Audio: string) => void): number {
    const now = Date.now();
    this.evictExpired(now);

    const pending = this.chunks.splice(0);
    this.firstChunkAtMs = null;

    for (const chunk of pending) {
      forward(chunk.base64Audio);
    }

    if (pending.length > 0) {
      logInfo("greeting_audio_buffer_flushed", { chunks: pending.length });
    }

    return pending.length;
  }

  hasBufferedAudio(): boolean {
    this.evictExpired(Date.now());
    return this.chunks.length > 0;
  }

  clear(): void {
    this.chunks = [];
    this.firstChunkAtMs = null;
  }

  private evictExpired(now: number): void {
    if (this.firstChunkAtMs !== null && now - this.firstChunkAtMs > MAX_BUFFER_AGE_MS) {
      logWarn("greeting_audio_buffer_expired", { bufferedChunks: this.chunks.length });
      this.clear();
      return;
    }

    this.chunks = this.chunks.filter((chunk) => now - chunk.receivedAtMs <= MAX_BUFFER_AGE_MS);
    if (this.chunks.length === 0) {
      this.firstChunkAtMs = null;
    }
  }
}
