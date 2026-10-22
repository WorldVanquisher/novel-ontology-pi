import { createServer, type ServerResponse } from "node:http";
import { stat } from "node:fs/promises";
import { eventLogPath, readEventBatch, validateCursor, cursorId, type LogIdentity } from "../events/log.js";

export interface WatchOptions {
  host?: "127.0.0.1" | "::1";
  port?: number;
  pollMs?: number;
  heartbeatMs?: number;
}

/** No ontology/store imports: this server can only read the processing log. */
export async function startWatch(novelDir: string, options: WatchOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("watch only accepts loopback addresses");
  const port = options.port ?? 4317;
  const pollMs = options.pollMs ?? 100;
  const heartbeatMs = options.heartbeatMs ?? 15000;
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(heartbeatMs) || heartbeatMs <= 0) throw new Error("Invalid watch options");
  if (!(await stat(novelDir)).isDirectory()) throw new Error("watch needs an existing novel directory");
  const path = eventLogPath(novelDir);
  const clients = new Set<() => void>();
  const jobs = new Set<Promise<void>>();
  let closing = false;
  let pollers = 0;
  let closePromise: Promise<void> | undefined;

  const server = createServer((req, res) => {
    const setup = async () => {
      if (closing) { res.writeHead(503).end(); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/events") { res.writeHead(404).end(); return; }
      if (req.method !== "GET") { res.writeHead(405, { Allow: "GET" }).end(); return; }
      // Browser development clients may live on a separate loopback port.
      // No wildcard CORS and no credentials; remote web origins get no access.
      if (req.headers.origin) {
        try {
          const origin = new URL(req.headers.origin);
          if ((origin.protocol === "http:" || origin.protocol === "https:") &&
              ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname) && origin.origin === req.headers.origin) {
            res.setHeader("Access-Control-Allow-Origin", origin.origin);
            res.setHeader("Vary", "Origin");
          }
        } catch { /* Invalid origins receive no CORS permission. */ }
      }
      const supplied = req.headers["last-event-id"] ?? url.searchParams.get("after") ?? cursorId(0);
      let offset: number;
      const identity: LogIdentity = {};
      try {
        if (typeof supplied !== "string") throw new Error("Invalid cursor");
        offset = await validateCursor(path, supplied, identity);
      } catch {
        res.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Invalid or unavailable cursor; reset client state and replay from zero" }));
        return;
      }
      if (closing || res.destroyed) { res.destroy(); return; }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let lastActivity = Date.now();
      const stop = () => {
        stopped = true;
        if (timer) { clearTimeout(timer); timer = undefined; pollers--; }
        clients.delete(stop);
        res.destroy();
      };
      clients.add(stop);
      res.once("close", stop);
      res.once("error", stop);
      // Backpressure is awaited, and close always releases the pending waiter.
      const send = async (frame: string) => {
        if (stopped) return;
        if (!res.write(frame)) await waitForDrain(res);
        lastActivity = Date.now();
      };
      const pump = async () => {
        try {
          const batch = await readEventBatch(path, offset, identity);
          for (const record of batch) {
            if (stopped) break;
            await send(`id: ${record.id}\ndata: ${JSON.stringify(record)}\n\n`);
            offset = Number(record.id);
          }
          if (!stopped && Date.now() - lastActivity >= heartbeatMs) await send(": heartbeat\n\n");
        } catch {
          // No raw fs/model errors in the stream. Client must explicitly reset
          // on corruption/rotation; history is never silently skipped.
          if (!stopped) res.write("event: stream.error\ndata: {\"error\":\"Event history unavailable; inspect log and reset cursor\"}\n\n");
          stop();
        }
        if (!stopped) {
          pollers++;
          timer = setTimeout(() => {
            timer = undefined;
            pollers--;
            track(pump());
          }, pollMs);
        }
      };
      track(pump());
    };
    track(setup().catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }));
  });
  function track(job: Promise<void>): void {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => undefined);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing watch address");
  return {
    url: `http://${host === "::1" ? "[::1]" : host}:${address.port}/events`,
    resources: () => ({ clients: clients.size, pollers, jobs: jobs.size }),
    close(): Promise<void> {
      return closePromise ??= (async () => {
        closing = true;
        const closed = new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
        for (const stop of [...clients]) stop();
        server.closeAllConnections();
        await closed;
        while (jobs.size) await Promise.allSettled([...jobs]);
      })();
    },
  };
}

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      res.off("drain", finish); res.off("close", finish); res.off("error", finish);
      resolve();
    };
    res.once("drain", finish); res.once("close", finish); res.once("error", finish);
    if (res.destroyed) finish();
  });
}
