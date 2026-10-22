import type { EventSource, PlaygroundEvent } from "../types";

/**
 * FileEventSource — the playground's event source over LOCAL FILES.
 *
 * Reads the session stream from a JSONL file (one {"at": ms, "event":
 * PlaygroundEvent} record per line) served next to the app — in
 * production this is the novel's `events.jsonl` written by the CLI;
 * `novel watch` will tail the same file / serve it over SSE. No
 * external APIs are involved anywhere in this loop.
 */
export class FileEventSource implements EventSource {
  private handlers = new Set<(event: PlaygroundEvent) => void>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private epoch = 0;

  constructor(private readonly url: string) {}

  subscribe(handler: (event: PlaygroundEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    this.stop();
    const myEpoch = this.epoch;
    // Single-file build: the stream is embedded in <script id="db-events">.
    const embedded = document.getElementById("db-events")?.textContent;
    let text: string;
    if (embedded) {
      text = embedded;
    } else {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`events file ${this.url}: HTTP ${res.status}`);
      text = await res.text();
    }
    // A stop()/restart during the fetch must not resurrect this run —
    // its timers would otherwise fire alongside the new session's.
    if (myEpoch !== this.epoch) return;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line) as { at: number; event: PlaygroundEvent };
      this.timers.push(
        setTimeout(() => {
          for (const h of this.handlers) h(rec.event);
        }, rec.at),
      );
    }
  }

  stop(): void {
    this.epoch++;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
