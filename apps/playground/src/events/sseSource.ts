import type { EventSource as PlaygroundEventSource, PlaygroundEvent } from "../types.js";
import { projectProcessingEvent, type EventRecord } from "./project.js";

/**
 * SseEventSource — the playground's LIVE event source over `novel watch`.
 *
 * Connects to the CLI watch server's SSE endpoint (loopback only,
 * default http://127.0.0.1:4317/events) and projects each streamed
 * EventRecord into PlaygroundEvents via ./project. The browser's
 * EventSource reconnects on its own and replays from the last record id
 * (the watch server honors Last-Event-ID), so a dropped tab picks the
 * stream back up without losing gate events.
 *
 * Live mode is VIEW-ONLY: the watch server is read-only by design, so
 * the gate itself stays in the CLI / with the main agent — approvals
 * appear here as stream events when they happen.
 *
 * Usage: serve the playground on a loopback origin and open it with
 * ?live=http://127.0.0.1:4317/events (see App.tsx).
 */
export class SseEventSource implements PlaygroundEventSource {
  private handlers = new Set<(event: PlaygroundEvent) => void>();
  private stream: EventSource | null = null;

  constructor(private readonly url: string) {}

  subscribe(handler: (event: PlaygroundEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private dispatch(event: PlaygroundEvent): void {
    for (const h of this.handlers) h(event);
  }

  start(): void {
    this.stop();
    const stream = new EventSource(this.url);
    this.stream = stream;
    stream.onmessage = (msg) => {
      try {
        const record = JSON.parse(msg.data as string) as EventRecord;
        for (const event of projectProcessingEvent(record.event)) {
          this.dispatch(event);
        }
      } catch {
        // A malformed frame is skipped, never fatal to the session.
      }
    };
    stream.addEventListener("stream.error", () => {
      this.dispatch({
        type: "verdict",
        patch: "watch",
        text: "⚠ watch stream reported unavailable history — reconnecting",
      });
    });
  }

  stop(): void {
    this.stream?.close();
    this.stream = null;
  }
}
