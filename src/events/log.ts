import { open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { projectEvent, type EventRecord, type EventSink, type ProcessingEvent } from "./types.js";

export const MAX_RECORD_BYTES = 1024 * 1024;
export const cursorId = (offset: number): string => String(offset).padStart(16, "0");
export const eventLogPath = (novelDir: string): string => join(novelDir, "events.jsonl");
const queues = new Map<string, Promise<unknown>>();

/** Per-reader identity guards replay/live handoff against replacement files.
 * It is not a persisted generation ID: offline rotation still requires reset.
 */
export interface LogIdentity { value?: string }

/** One append at a time per file; concurrent processes fail closed on an exclusive lock.
 * A crashed writer's lock needs operator inspection/removal. Never repair/truncate history here.
 */
export class EventLog {
  readonly path: string;
  constructor(novelDir: string) { this.path = resolve(eventLogPath(novelDir)); }
  readonly emit: EventSink = async (event) => { await this.append(event); };

  append(event: ProcessingEvent): Promise<EventRecord> {
    // Snapshot before queueing; callers may mutate their ChangeSet afterwards.
    const fact = projectEvent(event);
    const previous = queues.get(this.path) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const lock = await open(`${this.path}.lock`, "wx", 0o600);
      try {
        const file = await open(this.path, "a+", 0o600);
        try {
          const { size } = await file.stat();
          if (size) {
            const tail = Buffer.alloc(1);
            await file.read(tail, 0, 1, size - 1);
            if (tail[0] !== 10) throw new Error("Event log has an incomplete tail; inspect before appending");
          }
          const record: EventRecord = { version: 1, id: cursorId(0), timestamp: new Date().toISOString(), event: fact };
          const bytes = Buffer.byteLength(JSON.stringify(record) + "\n");
          if (bytes > MAX_RECORD_BYTES || !Number.isSafeInteger(size + bytes)) throw new Error("Event record exceeds log limits");
          record.id = cursorId(size + bytes);
          await file.writeFile(JSON.stringify(record) + "\n");
          await file.sync();
          return record;
        } finally { await file.close(); }
      } finally {
        try { await lock.close(); } finally { await unlink(`${this.path}.lock`); }
      }
    });
    queues.set(this.path, pending);
    void pending.finally(() => { if (queues.get(this.path) === pending) queues.delete(this.path); }).catch(() => undefined);
    return pending;
  }
}

/** Incremental, bounded read. Incomplete UTF-8/JSON lines stay on disk for the next poll. */
export async function readEventBatch(path: string, offset: number, identity?: LogIdentity): Promise<EventRecord[]> {
  let file;
  try { file = await open(path, "r"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT" && offset === 0) return []; throw err; }
  try {
    const { size, dev, ino } = await file.stat();
    if (identity) {
      const current = `${dev}:${ino}`;
      if (identity.value !== undefined && identity.value !== current) throw new Error("Event log was replaced; reset the client cursor");
      identity.value = current;
    }
    if (size < offset) throw new Error("Event log was truncated; reset the client cursor");
    const buffer = Buffer.alloc(Math.min(MAX_RECORD_BYTES, size - offset));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    const records: EventRecord[] = [];
    let start = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] !== 10) continue;
      const record = JSON.parse(buffer.subarray(start, i).toString("utf8")) as EventRecord;
      if (record.version !== 1 || record.id !== cursorId(offset + i + 1) || !record.timestamp || !record.event?.type) {
        throw new Error("Invalid event log record");
      }
      // Reject unknown types; never forward arbitrary log metadata to clients.
      records.push({ version: 1, id: record.id, timestamp: record.timestamp, event: projectEvent(record.event) });
      start = i + 1;
    }
    if (!start && bytesRead === MAX_RECORD_BYTES) throw new Error("Event log line exceeds limit");
    return records;
  } finally { await file.close(); }
}

/** Cursor must point to a complete record, not into a UTF-8 character or half-line. */
export async function validateCursor(path: string, id: string, identity?: LogIdentity): Promise<number> {
  if (!/^\d{16}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error("Invalid event cursor");
  const offset = Number(id);
  if (offset === 0) return 0;
  const file = await open(path, "r");
  try {
    const { size, dev, ino } = await file.stat();
    if (identity) identity.value = `${dev}:${ino}`;
    if (offset > size) throw new Error("Event cursor is ahead of history");
    const length = Math.min(offset, MAX_RECORD_BYTES);
    const tail = Buffer.alloc(length);
    await file.read(tail, 0, length, offset - length);
    if (tail[length - 1] !== 10) throw new Error("Event cursor is not a record boundary");
    const start = tail.lastIndexOf(10, length - 2) + 1;
    const record = JSON.parse(tail.subarray(start, length - 1).toString("utf8")) as EventRecord;
    if (record.version !== 1 || record.id !== id) throw new Error("Unknown event cursor");
    return offset;
  } finally { await file.close(); }
}
