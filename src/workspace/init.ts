import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { BundleManifest } from "../connectors/bundle.js";

/** Create a fresh workspace; existing paths (including symlinks) are refused. */
export async function initWorkspace(path: string): Promise<{
  status: "initialized";
  novelDir: string;
  manifest: BundleManifest;
}> {
  const novelDir = resolve(path);
  // Recursive creation is only for parents. Exclusive target creation also
  // prevents two initializers from writing into the same workspace.
  await mkdir(dirname(novelDir), { recursive: true });
  await mkdir(novelDir);

  const manifest: BundleManifest = {
    novelId: `novel_${randomUUID()}`,
    title: basename(novelDir),
    schemaVersion: 1,
    sourceLanguages: [],
    embeddingModel: null,
    embeddingDimension: null,
    decisionModel: process.env.JEV_MODEL?.trim() || "jev-1.13.0",
    blocksProcessed: 0,
  };

  for (const dir of ["source", "ontology", "branches", "changesets"]) {
    await mkdir(join(novelDir, dir));
  }
  const ontologyDir = join(novelDir, "ontology");
  for (const file of [
    "entities.jsonl", "relations.jsonl", "events.jsonl",
    "scenes.jsonl", "timelines.jsonl", "branches.jsonl",
  ]) {
    await writeFile(join(ontologyDir, file), "", { flag: "wx" });
  }
  // Write the manifest last so it only appears after the layout is complete.
  await writeFile(
    join(ontologyDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx" },
  );
  return { status: "initialized", novelDir, manifest };
}
