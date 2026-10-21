# Novel Ontology — Pi Skill + CLI Bundle
## Founding design (v0.1, 2026-10-21)

Turns a novel in any language into an ontology — characters, events,
causality, timelines — that powers character simulation and
parallel-universe story forking. Rebuild of
`gardianofthedarkness/agentic_chinese_novel_discord_bot` on a clean,
embedded, no-Docker architecture.

> **System 1 has its own detailed design page:**
> [`docs/system1.html`](docs/system1.html) — the autostep miniloop,
> decision patches, and the merge gate, with animations. This document
> covers everything else and only summarizes System 1.

---

## 1. Settled decisions (Qiguang, 2026-10-21)

| Decision | Choice |
|---|---|
| Language / runtime | TypeScript on the Pi agent (`earendil-works/pi`) |
| Repo | New repo; the old one stays as reference/design salvage |
| Form factor | Pi-agent-compatible **Skill + CLI bundle**: SKILL.md teaches the Pi agent the workflows; the CLI implements *all* functionality |
| Frontend order | CLI-first; Discord later as a thin layer over the CLI |
| Ontology storage | Embedded only — no Docker, no hosted server. Canonical form is a portable JSONL bundle; Ladybug is the hot query engine rebuilt from it |
| Internal language | All storage naming, schema, types, relations and mechanisms in **English**, so novels in any language map to the same paradigm |
| Bring-your-own-novel | Download, drop in a novel, provide two keys, it works |
| Timelines / forking | Canon is a timeline; the **user selects a time point** to fork a parallel universe |
| Model routing | User provides **one work LLM API** (generation) + **one decision model** (Jev, TypeSafe AI). Jev is a key user input; a key will be provided for testing |
| System 1 | An **autostep miniloop inside the CLI**: a Jev-based recursive decision system over auto-sectioned sentences, organized as **decision patches** (one patch per functionality) |
| Ingestion | Rolls **block by block** (chapter / long block); the miniloop accumulates proposed changes; the **main agent approves, holds, or sends back for revision** at a merge gate |

## 2. Architecture — two loops, one boundary

```
System 2 (outer)   Pi agent + SKILL.md
                   Workflows: ingest → review → query → simulate → fork.
                   Holds the full context: conversation, memory, user
                   intent, long-range consistency. Reviews every merge.
                   NEVER touches the DB or Jev directly — only the CLI.
                              │  CLI commands, JSON in / JSON out
System 1 (inner)   The CLI  (all functionality, unit-testable, no LLM needed for tests)
                   ├─ sectioning        deterministic code, no model
                   ├─ autostep miniloop decision patches over Jev
                   ├─ extraction        work LLM, per scene (not per chapter)
                   ├─ merge gate        ChangeSets: accumulate → review → apply
                   └─ connectors        Ladybug │ bundle │ Jev │ work LLM │ embeddings
```

Why the boundary matters: everything in the CLI is deterministic code +
typed decisions, so ingestion is testable on a golden chapter with a
mocked Jev connector and zero model spend. The Skill stays a teaching
document, not a codebase.

Pi packaging note: Pi loads a skill's name/description at startup and the
full SKILL.md only when a task matches, so the frontmatter description
*is* the routing signal — keep it tight.

## 3. Storage — bundle is truth, Ladybug is the hot engine

**Ladybug** (formerly Kuzu): an embedded property-graph database —
Cypher, columnar storage, ACID, one `.lbug` file, in-process. It natively
provides **full-text search (BM25)** and a **vector index (HNSW)** in the
same engine, which removes the old stack's Neo4j *and* Qdrant *and*
Postgres *and* Redis — all five Docker services collapse into the CLI.

Retrieval pattern (GraphRAG in one engine): vector/FTS search finds seed
nodes → Cypher traversal walks causal / presence / timeline edges.

Caveats designed around:
1. **Closed schema** — node/relation tables are declared up front
   (`src/ontology/schema.ts`). New types = a CLI migration.
2. **Vector dimension is fixed** at index creation — the embedding model
   is recorded in the bundle manifest; changing it means `graph reindex`.
3. **One writer + many readers** — exactly a CLI's access pattern.

Per-novel layout:
```
novels/<novel-id>/
  source/                 the novel file the user dropped in (unchanged)
  ontology/
    manifest.json         novel id, schema version, embedding model +
                          dimension, source language(s), pinned Jev version
    entities.jsonl  relations.jsonl  events.jsonl
    scenes.jsonl    timelines.jsonl  branches.jsonl
    graph.lbug            rebuilt from the bundle — disposable
  branches/<branch-id>/   delta events + fork-point state snapshot only
```
All DB access goes through one `OntologyStore` interface
(`src/ontology/store.ts`), so the engine can be swapped without touching
the miniloop or extraction. Sharing an ontology = copying the folder.

## 4. Schema v1 (English-canonical, language-neutral identity)

- Identity: opaque IDs only (`char_000123`, `evt_…`). Names are data:
  `names: [{ text, lang, kind: canonical|alias|nickname|title }]`.
- Semantics in English, evidence in the original: every event/scene
  stores an English `summary` + the original-language quote + sentence
  offsets as provenance.
- Node tables: `Character | Location | Organization | Item | Concept |
  Event | Scene | Timeline | Branch`
- Relations: `CAUSES | CAUSED_BY | PARTICIPATES_IN | PRESENT_IN |
  MENTIONED_IN | LOCATED_AT | KNOWS | SPEAKS_TO | ADDRESSES | OWNS |
  MEMBER_OF | STATE_BEFORE | STATE_AFTER | FORKS_FROM | PRECEDES`
- Event types: `dialogue | action | revelation | conflict | movement |
  decision | introduction | resolution | other`
- Character state at a point = **fold of the event stream** up to that
  point — never a mutable "current state" row.
- Fork: `Branch { id, parent_timeline_id, fork_event_id, label }`
  shares the canon prefix (no copying), snapshots state at the fork
  event, then appends only its own delta events. Canon is never mutated.

## 5. The processing model — blocks and the merge gate

This is how a novel actually gets ingested, end to end:

```
┌─ for each block (one chapter, or a long block of text) ────────────┐
│  1. SECTION     code splits the block into sentences (stable IDs,   │
│                 offsets = provenance for everything downstream)     │
│  2. MINIloop    decision patches run over the sentences; every      │
│                 conclusion becomes a PROPOSAL                       │
│  3. EXTRACT     work LLM reads the structured scenes and proposes   │
│                 events, causality, state changes                    │
│  4. ACCUMULATE  all proposals collect into ONE ChangeSet for the    │
│                 block — the main graph is NOT touched               │
│  5. MERGE GATE  the main agent reviews the ChangeSet:               │
│        approve → proposals applied to the main graph; roll on       │
│        hold    → nothing applied; processing pauses; user consulted │
│        revise  → named parts go back; the miniloop re-runs ONLY     │
│                  those parts and returns a revised ChangeSet        │
└─────────────────────────────────────────────────────────────────────┘
        … repeat until the novel the user asked for is done.
```

Why a human-shaped gate with an agent behind it: the miniloop is fast
and local, but it cannot hold what the main agent holds — earlier
chapters, naming consistency across a whole book, who a nickname really
belongs to, the user's intent. Making the fast system *propose* and the
context-rich system *decide* is the core safety property of the design.
ChangeSets are also the audit trail: every node in the graph can answer
"which block, which sentences, which patch, what confidence, who
approved you."

## 6. System 1 — summary (detail lives in docs/system1.html)

- **Decision patches.** Each functionality is an independent patch with
  its own Jev questions, primitives, and confidence gates:
  `scene-boundary`, `dialogue-detector`, `name-detector`,
  `presence-detector`, `speaker-attribution`, … Adding a functionality
  = adding a patch. Patches run in a fixed order and pass accepted
  decisions to each other.
- **Rule zero:** never ask a model what code can compute exactly.
  Sectioning, offsets, and scanning for *known* names are code. The
  decision model only judges what is genuinely ambiguous: which
  sentences are dialogue, whether a candidate is a *new* name or a
  nickname, who is present vs. merely mentioned, who speaks a line.
- **Primitives:** `noul` (yes/no → probability), `choice` (one pick from
  a fixed set), `score` (ordered scale). Presence must be one `noul`
  per candidate — `choice` can only return a single pick.
- **Recursion:** high confidence → accept and advance; middling →
  expand the context window and re-ask; split/low or a discovery →
  subdivide, or escalate that unit only to the work LLM.
- **Output is structure + proposals**, never text and never writes:
  scenes, turns, and a ChangeSet.
- The full patch catalog (state changes, event-worthiness, causal
  candidates, foreshadowing, …) and the animated walkthrough are on the
  System 1 page — kept as an **open discussion list** to cut, keep, and
  add to together.

## 7. CLI command surface

```
novel init <path>                  create a novel workspace + manifest
novel section <file>               deterministic sectioning only (free)
novel ingest <file>                section → miniloop → extract → ChangeSet
novel miniloop run|inspect         run the Jev loop; inspect decisions
novel changeset list|show|approve|hold|revise
                                   the merge gate
novel query <cypher>               graph traversal via OntologyStore
novel search <text>                hybrid FTS + vector seed search
novel timeline list|show           browse fork points by importance
novel fork create --at <event-id> --label <name>
novel simulate <character> [--branch <id>]
novel bundle export|import         portable ontology in / out
novel graph build|reindex          (re)build Ladybug from the bundle
novel config                       model routing (keys via secure entry)
```
JSON out by default, `--pretty` for humans.

## 8. Test plan that costs nothing

1. Golden chapter fixture (short, dialogue-heavy, multi-character).
2. Sectioning unit tests: CJK punctuation, nested quotes, abbreviations. ✅ (in repo)
3. Miniloop tests with a **mocked Jev connector** returning recorded
   probabilities — verifies gates, recursion, and ChangeSet accumulation. ✅ (in repo)
4. Bundle → Ladybug rebuild round-trip: same answers after a rebuild.
5. Only then: one live chapter with the real Jev key + one work LLM.

## 9. Open questions (to plan together)

- **Patch catalog details** — the full candidate list is on the System 1
  page. Which patches are v1, which wait? Current skeleton: scene
  boundary, dialogue detector, name detector, presence, speaker.
- **Name-candidate generation** — how does the name detector propose
  *candidate* spans for new names (speech-verb patterns, quote-adjacent
  capitalized/CJK sequences, work-LLM nomination)? Patch interface is
  ready; the generator is not decided.
- **Merge revision granularity** — when the main agent sends a ChangeSet
  back, what is the unit of revision: a proposal, a scene, a patch's
  whole output for the block?
- **Confidence thresholds** — starting proposal: accept ≥ 0.85,
  re-ask 0.55–0.85, escalate < 0.55 (per patch). To tune with the test key.
- **First test novel** — which sample novel is the first end-to-end case?
- **Embedding provider/model** — locks the vector index dimension.
- **Jev access route** — direct `api.typesafe.ai` vs. gateway; settled
  when the key is handed over (secure entry, never in chat).
