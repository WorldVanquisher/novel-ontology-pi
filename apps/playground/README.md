# Playground — sector 13 testing frontend

The unified debug/testing UI for novel-ontology-pi: **one graph, many
cameras**. The timeline lanes, a big event's 3D interior, the live
decision stream and the merge-gate queue are all views over the same
ontology graph — the agent knits where it knits, the user's camera is
never stolen, and a shining activity tab guides you to the work.

Design source of truth: `docs/system1/playground-frontend.html` in the
repo root.

## Run it

```bash
cd apps/playground
npm install
npm run dev        # http://localhost:5173
```

Requires **React 19** — Reagraph 4.32 bundles @react-three/fiber v9,
which crashes on React 18 internals ("reading 'S'" at reconciler
creation). The root CLI package is unaffected.

## Data: local files only

The app reads everything from local files under `public/db/novel/` —
a simulated novel bundle in the exact layout the CLI writes, plus the
playground read model and the session stream. No external APIs, no
CDN: even the graph's node labels are plain HTML projected from the
3D scene every frame, because Reagraph's built-in labels (troika /
drei Text) fetch font data from a CDN at runtime — and when that
fetch fails, the suspension takes the whole scene down with it.

| File | Role |
| --- | --- |
| `ontology/manifest.json`, `ontology/*.jsonl` | the simulated bundle (source of truth) |
| `view.json` | playground read model: positioned nodes/edges for lanes + interiors |
| `events.jsonl` | the PlaygroundEvent stream (`{"at": ms, "event": …}` per line) — the file `novel watch` will tail / serve over SSE |
| `changesets/cs_b0011.json` | the session's ChangeSet record |

`view.json` and `events.jsonl` are generated from the seed data in
`src/data/demoWorld.ts` + `src/events/demoSource.ts`:

```bash
node tools/gen-fixtures.mjs
```

## Single-file edition

```bash
npm run build && node tools/build-singlefile.mjs
```

Produces `playground-live.html` — the whole app plus the DB files
embedded, runnable fully offline from one file (handy for phone
testing).

## Contracts it codes against

- `PlaygroundEvent` stream (`src/types.ts`) — the same events the CLI
  will emit: `block.started`, `sectioned`, `verdict` (Jev),
  `proposal.added`, `changeset.pending` / `held` / `merged`,
  `graph.rebuilt`. Served by `FileEventSource` (`src/events/`).
- Ghost states: proposed (amber), held (slate), canon (kind colors).
  Held proposals stay held when the rest of the set merges.
- Notification policy (from Sirui's sector-13 feedback): gate arrivals
  and holds shine the activity tab immediately; ordinary proposals
  batch silently. Clicking the tab flies the camera to the knitting
  site. Agent activity never moves the camera on its own — framing
  happens only on view changes and explicit flights.
- Camera notes: `cameraMode="rotate"` — Reagraph's `"orbit"` is an
  auto-rotating showcase mode (20°/s), not mouse-orbit. Node
  positions are pinned via `fx/fy/fz` (v4.32 ignores a `position`
  field) in the chronological layout; "force" unpins them. Initial
  framing is computed from the node positions (`framePositions`)
  rather than Reagraph's `fitNodesInView`.

Verified end-to-end headlessly (Chromium + SwiftShader): session
replay, gate fill, hold, guided flight, approve → merged, in both
dev-server mode and the offline single file, with zero console
errors.
