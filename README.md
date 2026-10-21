# novel-ontology-pi

A **Pi-agent-compatible Skill + CLI bundle** that turns a novel — in any
language — into a queryable **ontology** of characters, events, causality
and timelines, powering **character simulation** and **parallel-universe
story forking** at a time point the user chooses.

No Docker. No hosted database. Download it, drop in your novel, provide
two API keys (one work LLM + one decision model), and start.

## How it works

- **The Skill** (`skills/novel-ontology/SKILL.md`) teaches a
  [Pi agent](https://github.com/earendil-works/pi) the workflows:
  ingest → review → query → simulate → fork.
- **The CLI** (`novel`) implements everything: deterministic sentence
  sectioning, ontology extraction, storage, queries, forking.
- **System 1 — the autostep miniloop** (inside the CLI): a recursive
  decision system built on **Jev** (TypeSafe AI's decision model). It
  works as independent **decision patches** — a dialogue detector, a name
  detector, a presence detector, a speaker attributor — each asking the
  decision model small typed questions (`noul` / `choice` / `score`)
  over auto-sectioned sentences.
- **The merge gate:** the miniloop never writes to the ontology main
  graph. Per chapter/block it accumulates a **ChangeSet** of proposed
  changes, and the main agent — holding the full context — **approves,
  holds, or sends parts back for revision**. Block by block, until the
  novel is done.
- **Storage:** a portable JSONL **bundle** is the source of truth;
  **Ladybug** (embedded property graph + Cypher, with native full-text
  and vector indexes) is the hot query engine rebuilt from it. One local
  folder per novel. Internal naming is all English, so novels in any
  language share one paradigm.

📐 **Design:** [DESIGN.md](DESIGN.md) ·
🧠 **System 1 in detail (by sector):** [docs/system1/index.html](docs/system1/index.html) ·
📱 **Single-file viewer** (all sector pages in one self-contained HTML, clickable anywhere): [docs/system1-viewer.html](docs/system1-viewer.html) — regenerate with `node tools/build-viewer.mjs`

## Quick start

```bash
npm install
npm run build
npm test                                   # mocked Jev — costs nothing

# Create a fresh workspace (no models or API keys needed):
node dist/src/cli.js init novels/my-novel --pretty

# Deterministic sectioning (works today):
node dist/src/cli.js section path/to/chapter.txt --pretty
```

`init` requires a new target path and creates missing parent directories. It
refuses existing files, directories (even empty ones), and symlinks. The workspace
contains `source/`, `ontology/`, `branches/`, and `changesets/`; `ontology/` holds
the schema-v1 manifest and six empty JSONL bundle files. The manifest uses an
opaque novel ID, the directory name as its title, unknown source languages
(`[]`), no embeddings (`null`), and zero processed blocks. The decision-model
version is recorded from `JEV_MODEL`, defaulting to `jev-1.13.0` as in
`.env.example`; no model is called. A filesystem failure may leave a partial
directory; inspect it before removing it or choosing a new path.

Once a bundle's graph has been built
(`node dist/src/cli.js graph build novels/my-novel/ontology`), the workspace
can be browsed without any model calls:

```bash
node dist/src/cli.js query novels/my-novel "MATCH (c:Character) RETURN c.id AS id" --pretty
node dist/src/cli.js search novels/my-novel "café" --pretty
node dist/src/cli.js timeline list novels/my-novel --pretty
node dist/src/cli.js timeline show novels/my-novel tl_canon --pretty
```

`query` runs Cypher against the novel's built graph (`ontology/graph.lbug`).
`search` is the graph-first text search over canonical names and event
summaries (`--limit N`, default 20). `timeline list` shows the timelines
with their event counts; `timeline show` lists one timeline's fork-point
events — importance at least `--min-importance N` (default 0.5), in story
order. All output is JSON, `--pretty` for humans. A novel whose graph has
not been built, an unknown timeline ID, and missing or invalid arguments
are clear errors (JSON on stderr, exit code 1); the read commands never
create a database as a side effect.

Configuration (see `.env.example`): `WORK_LLM_*` for the one work LLM
API, `TYPESAFE_API_KEY` + pinned `JEV_MODEL` for the decision model.
Keys are user inputs — provide them via environment/secure entry, never
commit them.

## Sharing a novel: bundle export / import

The JSONL bundle is the source of truth, so sharing a novel = moving the
bundle folder. The graph database is *not* part of it — it is rebuilt
locally from the bundle.

```bash
node dist/src/cli.js bundle export <novel-dir> <out-dir>     # writes a NEW dir
node dist/src/cli.js bundle import <bundle-dir> <target-dir> # writes a NEW dir
node dist/src/cli.js graph build <target-dir>/ontology       # rebuild the graph
```

- **Export includes** the whole bundle, byte-for-byte: `source/`,
  `ontology/manifest.json` + all JSONL (entities, relations, events,
  scenes, timelines, branches), `branches/<id>/` deltas and snapshots,
  and the `changesets/` audit trail. IDs, source evidence, timelines and
  fields written by newer versions are preserved exactly.
- **Export excludes** the derived Ladybug graph (`graph.lbug*` —
  rebuild it with `graph build`) and secret-shaped files (`.env*`,
  private keys, credentials), which are listed in the command output.
- **Import validates before writing anything**: manifest shape and
  schema version, every JSON file parses, every JSONL line parses
  (errors name the file and line). The copy is staged next to the
  target and moved into place only when complete, so a failed import
  leaves no partial folder behind.
- **Nothing is ever overwritten**: if the target directory already
  exists, both commands stop with an error and leave it untouched.

## Status

Read-only processing event streaming: `novel watch <novel-dir> [--port 4317]`
serves loopback SSE from the workspace's processing `events.jsonl` (separate
from `ontology/events.jsonl`). See the [contract draft and SSH setup](docs/playground-events-watch.md)
for replay, integration limits, and frontend questions. `watch` never reviews
or applies ChangeSets; the CLI ingest path is still not wired.

v0.1 skeleton (2026-10-21): founding design, Skill, CLI skeleton with
working sectioning, decision-patch interfaces + v1 patches, ChangeSet /
merge-gate machinery, ontology schema v1, and connector interfaces for
Ladybug, the bundle, Jev, and the work LLM. Live wiring (Ladybug driver,
Jev key, Pi provider layer) lands incrementally — see the open questions
in DESIGN.md §9.

## Lineage

A clean-slate rebuild of
[agentic_chinese_novel_discord_bot](https://github.com/gardianofthedarkness/agentic_chinese_novel_discord_bot)
(Python/LangGraph + Neo4j/Postgres/Qdrant/Redis under Docker), keeping
its ontology and timeline/fork design ideas and replacing the stack.
