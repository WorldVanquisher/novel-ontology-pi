import { startWatch } from "./server.js";

export async function watchCommand(args: string[]): Promise<void> {
  const [novelDir, ...flags] = args;
  if (!novelDir || novelDir.startsWith("--")) throw new Error("Usage: novel watch <novel-dir> [--port N]");
  let port = 4317;
  if (flags.length) {
    if (flags.length !== 2 || flags[0] !== "--port" || !/^\d+$/.test(flags[1])) throw new Error("Usage: novel watch <novel-dir> [--port N]");
    port = Number(flags[1]);
  }
  const watch = await startWatch(novelDir, { port });
  console.log(JSON.stringify({ status: "watching", url: watch.url, readOnly: true }));
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      void watch.close().then(resolve, reject);
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
