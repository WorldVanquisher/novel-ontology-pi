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
  folder per novel. Schema keys and enum values are English; summaries
  and entity names stay in the novel's language and original script.
  The legacy `summaryEn` field holds source-language text.

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

## Work LLM smoke tests: `llm ping` / `llm probe`

The work-LLM plumbing — an OpenAI-compatible chat-completions client
(`src/connectors/workModel.ts`, configured from `WORK_LLM_*`) — can be
exercised before any live wiring exists:

```bash
node dist/src/cli.js llm ping  --pretty   # one tiny completion: reachability + latency + token usage
node dist/src/cli.js llm probe --pretty   # JSON-mode completion, reply validated as JSON
```

`WORK_LLM_BASE_URL` overrides the provider's default API root
(deepseek: `https://api.deepseek.com/v1`, openai:
`https://api.openai.com/v1`), so both commands can be pointed at a
local mock server and run for free with a dummy `WORK_LLM_API_KEY`.
The key is reported as status only (`configured`) and never printed.
A missing key, model, or base URL is a specific error, not a silent
skip. Transient failures (5xx, network) are retried with backoff;
4xx is not retried; each attempt times out after 30s. The client is
wired into `ingest`: when `WORK_LLM_*` is configured, the per-scene
extraction step (sector 08) runs between the miniloop and the merge
gate — `--no-extract` forces it off, and the ingest result reports
`extraction: "live" | "off"` so its absence is never silent.

## Jev key management: `jev login` / `status` / `logout` / `ping`

The CLI keeps its own durable secret store for the decision-model
key, so the key does not have to live in the environment:

```bash
node dist/src/cli.js jev login            # hidden prompt; stores the key (file mode 0600, outside the repo)
node dist/src/cli.js jev login --from-env # copy TYPESAFE_API_KEY into the store instead
node dist/src/cli.js jev status           # source only: env / store / env-indirect / missing
node dist/src/cli.js jev logout           # remove the stored copy
node dist/src/cli.js jev ping  --pretty   # one tiny live decision through the resolved key
```

Resolution order (the same one open-source Jev integrations use):
`TYPESAFE_API_KEY` env → the secure store → the env var named by
`JEV_API_KEY_ENV`. The store lives under `~/.config/novel-ontology/`
(`NOVEL_SECRETS_DIR` overrides it), never inside a novel bundle, and
no command ever prints the key. The live client speaks the real
System One wire format with the model pinned (`JEV_MODEL`, default
`jev-1.13.0`); transient failures (429/529/5xx, network) retry with
backoff, other 4xx fail at once.

## Measuring: `inspect` and `eval run`

Phase 2 measurement tooling — numbers only. Nothing in this section
sets or checks a threshold: what the numbers mean, and what (if
anything) they should gate, is the maintainer's decision.

### `novel inspect <novel-dir>` — corpus diagnostics

```bash
node dist/src/cli.js inspect path/to/novel --pretty
```

Reads the bundle JSONL + manifest (the source of truth; the Ladybug
graph is never opened — the report only notes whether `graph.lbug`
exists) and reports: the manifest summary; source-corpus size
(files, bytes, characters, chapters and blocks per the deterministic
text tools); ontology counts by kind/type/timeline/chapter; coverage
tallies (events with evidence, events placed on known timelines,
entities with canonical names, unresolved dialogue turns); integrity
tallies (relation endpoints and other references pointing at ids that
do not exist in the bundle — counted, never repaired); branch and
ChangeSet tallies. Counts and ratios of stored data only — no quality
judgments, no semantic validation. A corrupt JSONL line is an error
naming the file and line; missing optional files read as clean zeroes.

### Golden-chapter eval datasets

A dataset is a directory:

```
my-dataset/
  dataset.json          { "name": "...", "chapters": [
                            { "id": "ch01", "source": "chapters/ch01.txt",
                              "golden": "golden/ch01" } ] }
  chapters/ch01.txt     the chapter's source text
  golden/ch01/          expected records, in bundle record shapes:
    entities.jsonl  relations.jsonl  events.jsonl
```

Golden files use exactly the bundle's JSONL shapes
(`src/ontology/types.ts`). Every scored kind needs its file — write an
empty file for a kind with no records. A worked example ships in
`eval/examples/golden-chapter/` (one hand-written chapter, expected
records, and sample predictions).

### `novel eval run <dataset-dir> <predictions-dir>` — precision/recall

Predictions are *data*: a directory with one subfolder per chapter id,
each holding `entities.jsonl` / `relations.jsonl` / `events.jsonl` in
the same shapes. Anything can produce them — a recorded pipeline run,
a mock, a future live run. The runner never calls a model. A missing
chapter folder or kind file in the predictions counts as "predicted
nothing"; unknown chapter folders or unknown `.jsonl` files are
errors (they would silently corrupt the scores).

Matching is per chapter and kind, in two passes:

1. **Exact id** — a predicted record whose `id` equals a golden
   record's `id` matches it (recorded runs keep their ids).
2. **Semantic key** over the leftovers:
   - entity: `entity:<kind>:<canonical name>` (the `names[]` entry
     with kind `canonical`, else the first name)
   - relation: `relation:<type>:<from>-><to>`, where each endpoint is
     the semantic key of the record it references *in the same chapter
     and side* (golden relations resolve against golden records), or
     `id:<raw id>` when the endpoint doesn't resolve
   - event: `event:<timelineId>:<summary>`, the summary normalized
     (trimmed, whitespace-collapsed, lowercased)

Matching is a multiset match — duplicate keys pair off one-for-one.
The report gives TP/FP/FN and precision/recall/F1 per kind and overall
(and per chapter), plus the missed and spurious record keys so a
human can inspect every disagreement. Precision is `null` when
nothing was predicted for a slice; recall is `null` when the slice
has no golden records. A completed scoring run exits 0 whatever the
numbers are — non-zero exits mean usage, IO, or format errors only.

### `novel eval extract <novel-dir> <predictions-dir>` — predictions from a bundle

`eval run` scores predictions as data; `eval extract` is the producer
that makes them from a real ingest. It projects the bundle's stored
ontology (`ontology/entities.jsonl`, `relations.jsonl`,
`events.jsonl`) into a predictions directory in exactly the format
above — records copied as stored, ids included — split per chapter.
No model calls.

Chapter folders are named `ch<NN>`, where NN is the stored
`chapterIndex` zero-padded to two digits (`ch01`, `ch02`, …); name a
dataset's chapters the same way so the runner lines them up.

Only events and scenes carry a `chapterIndex`, so the split uses
stored fields only:

- **events** go to their own `chapterIndex`;
- **entities** carry no chapter field, so an entity is projected into
  every chapter where a stored scene or event places it (scene
  presence/mentions/location/dialogue turns; event primary actors /
  affected characters);
- **relations** carry no chapter field either, so a relation is
  projected into the chapters *both* endpoints are placed in — a
  relation spanning two chapters (say, a `PRECEDES` between their
  events) lands in neither.

Records no stored field ties to a chapter are counted as
`unattributed` in the command's report — never guessed at, never
silently dropped. The target directory must not already hold files:
like bundle import, the adapter never overwrites, so a stale
projection cannot corrupt a score.

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

## Gate review tooling: `match` / `fix` / `recall`

The merge gate's review is staged. `novel match <novel-dir>
[--changeset <id>]` produces the entity-matching packet: code
nominates duplicate pairs (shared forms, script-variant folds,
containment, near-identical forms), System 1 (Jev) reviews the whole
batch with a three-question checklist, and only the pairs it cannot
settle are raised to the agent — confident pairs arrive with a ready
merge command. `novel fix …` applies pointwise repairs over the
bundle (`merge`, `rename`, `add-form`, `relate`, `unrelate`,
`remove-entity`, `remove-event`), each audited in `maintenance.jsonl`
with the graph rebuilt after it. When a whole subtree is wrong, the
agent pins the early decision that caused the cascade
(`novel fix correct --block <id> --key <decision-key> --value <v>`)
and `novel recall <novel-dir> <blockId>` re-runs just that block from
the workspace's stored source with the pin honored.

For an extraction-origin identity cascade, pin `extraction:constraints`
with a JSON object containing `distinctNames` (groups of different
identities, never aliases of one person), `rejectCharacterNames` (explicit
invalid placeholders), and/or `instructions` (source-grounded guidance).
Recall feeds this correction into extraction and the name resolver,
preserves the superseded ChangeSet, and leaves a fresh held set for full
review. Corrections and recalls are audited; an already approved block
cannot be recalled without a canonical rollback plan.

Large review packets support `novel changeset show <dir> <id> --summary`
and `--offset 0 --limit 20`; follow `page.nextOffset` until null. Add
`--notes` to page through review notes without truncating the Bash output.

Live processing also writes owner-only, atomically replaced
`working/<block-id>.json` snapshots after real Jev patches and each extracted
scene. These are disposable, uncommitted working drafts: scene/dialogue
decisions and candidate stubs can be rendered as ghosts immediately. They
never update ontology files or bypass the merge gate. Final proposals still
arrive in the normal persisted ChangeSet; the metadata-only processing log
continues to exclude raw payloads and source quotes.

## Status

### Optional Pi reviewer and real test report

The [scoped Pi runner](tools/pi-review/README.md) loads the skill and uses
only CLI commands to review, repair and apply blocks. It requires full
source and current-revision proposal/note coverage before approval, keeps
private checkpoints, supports explicit per-block repair budgets, and
exports source-redacted native Pi session replay. It never auto-approves
or starts a public tunnel. Its SDK dependencies are optional and separate
from the CLI installation.

The [2026-10-22 live integration report](docs/reports/pi-review-live-2026-10-22.md)
records four chapter sections / six blocks, 2,558 supported proposals
applied and 594 deferred, with limitations and separate offline tests.

Read-only processing event streaming: `novel watch <novel-dir> [--port 4317]`
serves loopback SSE from the workspace's processing `events.jsonl` (separate
from `ontology/events.jsonl`). See the [contract draft and SSH setup](docs/playground-events-watch.md)
for replay, integration limits, and frontend questions. `watch` never reviews
or applies ChangeSets. The CLI ingest path **is** wired: `novel ingest
<novel-dir> <file>` runs blocks -> miniloop -> ChangeSets -> merge gate
(stops at the first gate by default; `--auto-approve` applies in-process),
and the playground follows a run live via `?live=http://127.0.0.1:4317/events`.
Re-running ingest with the same input and block size skips approved blocks
with recorded application, preserving their ChangeSets and the remaining
blocks' sentence provenance. An approval without an application record stops
the run for inspection rather than silently replaying or skipping it.

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
