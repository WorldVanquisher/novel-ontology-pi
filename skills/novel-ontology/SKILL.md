---
name: novel-ontology
description: Turn a novel (any language) into a queryable ontology of characters, events, causality and timelines, then simulate characters and fork parallel-universe storylines at a chosen time point. Use when the user wants to ingest a novel, ask questions about its world, roleplay/simulate a character, or branch the story.
---

# Novel Ontology — operating the CLI bundle

You are the **main agent (System 2)**. All functionality lives in the
`novel` CLI; you never query the database or the decision model directly.
Every CLI command returns JSON — read it, then explain results to the user
in plain language.

## Model routing (two user-provided APIs)

- **Work LLM** — one user-provided LLM API: extraction, summaries,
  simulation, story generation.
- **Decision model (Jev)** — powers the System 1 miniloop inside the CLI.
  You never call it yourself.
- If `novel config` reports a missing key, ask the user to provide it
  through secure entry. **Never ask for a key in chat, never invent one.**

## Workflow 1 — Ingest a novel (the merge gate is yours)

Ingestion rolls **block by block** (a chapter, or a long block). For each
block the CLI sections the text, runs the System 1 miniloop (decision
patches: scene boundaries, dialogue, names, presence, speakers), extracts
events per scene, and accumulates a **ChangeSet: proposed changes to the
ontology main graph. Nothing is merged yet.**

1. Run `novel ingest <file>` and read the ChangeSet summary.
2. **Review it like an editor, not a rubber stamp.** You hold the context
   the miniloop cannot: earlier chapters, the user's intent, naming
   consistency, character identity across aliases and languages.
3. Decide:
   - `novel changeset approve <id>` — merge into the main graph, roll on.
   - `novel changeset hold <id>` — pause and tell the user why.
   - `novel changeset revise <id> --notes <...>` — send specific parts
     back; the miniloop re-runs only those parts.
4. Low-confidence units and escalations are shown to the user, never
   silently re-decided by you.
5. Repeat until the novel is done; report progress per block.

## Workflow 2 — Answer questions about the novel

Use `novel search <text>` (hybrid FTS + vector seeds) and
`novel query <cypher>` for traversal: causal chains ("what led to X?"),
presence ("who was there when...?"), relationships, timelines.
Cite event IDs and quote the stored evidence when it matters.

## Workflow 3 — Fork a parallel universe

1. `novel timeline show` — browse time points by chapter/event, sorted
   with importance so the interesting forks surface first.
2. The **user selects the time point**. Then:
   `novel fork create --at <event-id> --label <name>`.
3. A branch shares the canon prefix — canon is never mutated. Simulation
   and continuation happen on the branch.

## Workflow 4 — Simulate a character

`novel simulate <character> [--branch <id>]` — character state is the fold
of events up to the current point on that timeline/branch, so the
character knows only what they should know at that point. Stay in
character; if the user pushes past the fork point or into another branch,
say which timeline you are on.

## Workflow 5 — Share an ontology

`novel bundle export` produces the portable bundle folder (JSONL +
manifest). Anyone with the bundle + the CLI can rebuild the graph
locally with `novel graph build` — no server, no Docker.

## Hard rules

- Never bypass the merge gate. If a ChangeSet looks wrong, hold or revise.
- Never write to the main graph except through an approved ChangeSet.
- Internal names are English and IDs are opaque; surface forms in the
  novel's own language are data — quote them as-is to the user.
