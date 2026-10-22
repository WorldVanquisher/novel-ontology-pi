#!/usr/bin/env node
/**
 * novel — the CLI half of the Skill + CLI bundle.
 *
 * The Pi agent (guided by skills/novel-ontology/SKILL.md) calls ONLY this
 * CLI. The CLI owns all functionality: sectioning, the System 1 miniloop,
 * extraction, the merge gate, and the database connectors.
 * All commands print JSON by default; add --pretty for humans.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { sectionBlock } from "./text/sectioning.js";
import { cutBlocks } from "./text/blocks.js";
import { initWorkspace } from "./workspace/init.js";
import { buildGraphFromBundle, LadybugStore } from "./connectors/ladybug.js";
import { BundleStore } from "./connectors/bundle.js";
import { exportBundle, importBundle } from "./connectors/bundleTransfer.js";
import { applyChangeSet } from "./merge/apply.js";
import {
  listChangeSets,
  loadChangeSet,
  setChangeSetStatus,
} from "./merge/changesetStore.js";

const COMMANDS: Record<string, string> = {
  "novel init <path>": "Create a novel workspace + bundle manifest",
  "novel section <file>": "Deterministic sentence sectioning only (free, testable)",
  "novel blocks <file> [--size N]": "Chapter detection + block cutting map (no models)",
  "novel ingest <file>": "Section -> miniloop -> extract -> ChangeSet (merge gate)",
  "novel miniloop run|inspect": "Run the Jev miniloop; inspect per-window decisions",
  "novel changeset list|show|approve|hold <novel-dir> [id]":
    "The merge gate: review accumulated proposals before they touch the main graph",
  "novel graph build <bundle-dir> [db-path]": "(Re)build the Ladybug store from the bundle",
  "novel graph query <db-path> <cypher>": "Raw Cypher against the Ladybug store",
  "novel graph stats <db-path>": "Node/relation counts per table",
  "novel query <cypher>": "OntologyStore query (graph traversal)",
  "novel search <text>": "Graph-first text search (Cypher CONTAINS scan)",
  "novel timeline list|show": "Browse time points (chapter / event, by importance)",
  "novel fork create --at <event-id> --label <name>": "Fork a parallel universe at a time point",
  "novel simulate <character> [--branch <id>]": "Character simulation on canon or a branch",
  "novel bundle export <novel-dir> <out-dir>":
    "Export the portable bundle (JSONL + manifest; graph DB and secrets excluded)",
  "novel bundle import <bundle-dir> <target-dir>":
    "Import a bundle into a new novel dir (validates first; never overwrites)",
  "novel graph reindex": "Deferred: no vector/FTS indexes in the graph-first phase",
  "novel config": "Show model routing config (keys via env / secure entry only)",
};

function out(obj: unknown, pretty: boolean): void {
  console.log(pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pretty = args.includes("--pretty");
  const positional = args.filter((a) => a !== "--pretty");
  const [cmd, sub] = positional;

  if (!cmd || cmd === "help" || cmd === "--help") {
    out({ tool: "novel", commands: COMMANDS }, true);
    return;
  }

  if (cmd === "init") {
    if (!sub?.trim() || sub.startsWith("--") || positional.length !== 2) {
      throw new Error("Usage: novel init <path> [--pretty]");
    }
    out(await initWorkspace(sub), pretty);
    return;
  }

  if (cmd === "config") {
    out(loadConfig(), pretty);
    return;
  }

  if (cmd === "section" && sub) {
    const text = await readFile(sub, "utf8");
    const { sentences, paragraphCount } = sectionBlock(text, 0);
    out({ file: sub, paragraphCount, sentences }, pretty);
    return;
  }

  if (cmd === "blocks" && sub) {
    const text = await readFile(sub, "utf8");
    const size = Number(flag(positional, "--size") ?? 24000);
    const blocks = cutBlocks(text, size);
    out(
      {
        file: sub,
        blockCount: blocks.length,
        blocks: blocks.map((b) => ({
          id: b.id,
          chapterIndex: b.chapterIndex,
          chapterTitle: b.chapterTitle,
          startOffset: b.startOffset,
          endOffset: b.endOffset,
          charCount: b.charCount,
          opening: b.text.slice(0, 40).replace(/\n/g, " "),
        })),
      },
      pretty,
    );
    return;
  }

  if (cmd === "graph" && sub === "build" && positional[2]) {
    const bundleDir = positional[2];
    const dbPath = positional[3] ?? join(bundleDir, "graph.lbug");
    const counts = await buildGraphFromBundle(bundleDir, dbPath);
    out({ status: "built", bundleDir, dbPath, counts }, pretty);
    return;
  }

  if (cmd === "graph" && sub === "query" && positional[2] && positional[3]) {
    const store = new LadybugStore(positional[2]);
    const rows = await store.run(positional.slice(3).join(" "));
    out({ rows }, pretty);
    await store.close();
    return;
  }

  if (cmd === "graph" && sub === "stats" && positional[2]) {
    const store = new LadybugStore(positional[2]);
    const tables = [
      "Character", "Location", "Organization", "Item", "Concept",
      "Event", "Scene", "Timeline", "Branch",
    ];
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const rows = await store.run(`MATCH (n:${t}) RETURN count(n) AS c`);
      counts[t] = Number(rows[0]?.c ?? 0);
    }
    out({ dbPath: positional[2], counts }, pretty);
    await store.close();
    return;
  }

  if (cmd === "changeset" && sub && positional[2]) {
    const novelDir = positional[2];
    if (sub === "list") {
      const all = await listChangeSets(novelDir);
      out(
        {
          novelDir,
          changesets: all.map((c) => ({
            id: c.id,
            blockId: c.blockId,
            status: c.status,
            proposals: c.proposals.length,
            createdAt: c.createdAt,
          })),
        },
        pretty,
      );
      return;
    }
    const id = positional[3];
    if (!id) throw new Error(`changeset ${sub} needs a changeset id`);
    if (sub === "show") {
      out(await loadChangeSet(novelDir, id), pretty);
      return;
    }
    if (sub === "hold") {
      const cs = await setChangeSetStatus(novelDir, id, "held");
      out({ id: cs.id, status: cs.status }, pretty);
      return;
    }
    if (sub === "approve") {
      const ontologyDir = join(novelDir, "ontology");
      let cs = await setChangeSetStatus(novelDir, id, "approved");
      const bundle = new BundleStore(ontologyDir);
      const { applied } = await applyChangeSet(bundle, cs);
      const counts = await buildGraphFromBundle(
        ontologyDir,
        join(ontologyDir, "graph.lbug"),
      );
      cs = await loadChangeSet(novelDir, id);
      out(
        { id: cs.id, status: cs.status, applied, graph: counts },
        pretty,
      );
      return;
    }
  }

  if (cmd === "bundle" && sub === "export" && positional[2] && positional[3]) {
    const result = await exportBundle(positional[2], positional[3]);
    out({ status: "exported", ...result }, pretty);
    return;
  }

  if (cmd === "bundle" && sub === "import" && positional[2] && positional[3]) {
    const result = await importBundle(positional[2], positional[3]);
    out({ status: "imported", ...result }, pretty);
    return;
  }

  // Everything else is specified in DESIGN.md and lands incrementally.
  out(
    {
      status: "not_implemented",
      command: positional.join(" "),
      note: "See DESIGN.md for the command contract; the roadmap page tracks what has landed.",
    },
    pretty,
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
