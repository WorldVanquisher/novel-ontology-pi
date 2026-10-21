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
import { sectionBlock } from "./text/sectioning.js";

const COMMANDS: Record<string, string> = {
  "novel init <path>": "Create a novel workspace + bundle manifest",
  "novel section <file>": "Deterministic sentence sectioning only (free, testable)",
  "novel ingest <file>": "Section -> miniloop -> extract -> ChangeSet (merge gate)",
  "novel miniloop run|inspect": "Run the Jev miniloop; inspect per-window decisions",
  "novel changeset list|show|approve|hold|revise":
    "The merge gate: review accumulated proposals before they touch the main graph",
  "novel query <cypher>": "OntologyStore query (graph traversal)",
  "novel search <text>": "Hybrid FTS + vector seed search",
  "novel timeline list|show": "Browse time points (chapter / event, by importance)",
  "novel fork create --at <event-id> --label <name>": "Fork a parallel universe at a time point",
  "novel simulate <character> [--branch <id>]": "Character simulation on canon or a branch",
  "novel bundle export|import": "Portable ontology bundle in/out",
  "novel graph build|reindex": "(Re)build the Ladybug store from the bundle",
  "novel config": "Show model routing config (keys via env / secure entry only)",
};

function out(obj: unknown, pretty: boolean): void {
  console.log(pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj));
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

  if (cmd === "section" && sub) {
    const text = await readFile(sub, "utf8");
    const { sentences, paragraphCount } = sectionBlock(text, 0);
    out({ file: sub, paragraphCount, sentences }, pretty);
    return;
  }

  // Everything else is specified in DESIGN.md and lands incrementally.
  out(
    {
      status: "not_implemented",
      command: positional.join(" "),
      note: "Skeleton build — see DESIGN.md for the command contract.",
    },
    pretty,
  );
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
