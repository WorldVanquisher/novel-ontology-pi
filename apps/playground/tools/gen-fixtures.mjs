/**
 * One-shot fixture generator: serializes the in-code demo world and the
 * scripted session into the LOCAL DB FILES the app now consumes:
 *
 *   public/db/novel/view.json      — playground read model (positioned graph)
 *   public/db/novel/events.jsonl   — the PlaygroundEvent stream (session b0011)
 *
 * The raw simulated bundle (manifest + ontology/*.jsonl) is hand-kept
 * alongside them in the same directory — same layout as a real novel
 * bundle produced by the CLI.
 *
 * Run: node tools/gen-fixtures.mjs   (requires esbuild from node_modules)
 */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "db", "novel");
await mkdir(outDir, { recursive: true });

async function bundleToModule(entry, name) {
  const outfile = join(root, "tools", `.tmp-${name}.mjs`);
  await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href);
}

const world = await bundleToModule("src/data/demoWorld.ts", "world");
const demo = await bundleToModule("src/events/demoSource.ts", "demo");

const view = {
  laneNodes: world.LANE_NODES,
  laneEdges: world.LANE_EDGES,
  interiors: world.INTERIORS,
  bigEventLabels: world.BIG_EVENT_LABELS,
};
await writeFile(join(outDir, "view.json"), JSON.stringify(view, null, 2) + "\n");

const lines = demo.SCRIPT.map((s) => JSON.stringify({ at: s.at, event: s.event }));
await writeFile(join(outDir, "events.jsonl"), lines.join("\n") + "\n");

console.log("fixtures written to", outDir);
