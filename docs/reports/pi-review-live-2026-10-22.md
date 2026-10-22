# Pi review integration test — 2026-10-22

## Scope and provenance

This is a real paid-model integration run, not a fixture or simulated
success. It used a fresh isolated database and a locally supplied Chinese
novel: volume 1's prologue and chapters 1–3, four chapter sections in six
24,000-character-bounded blocks. No source text or identifying novel data
is included in this report.

- Started: **2026-10-22 13:37:22.636 UTC**.
- Finished: **2026-10-22 14:29:19.927 UTC**.
- Elapsed: **51 minutes 57.291 seconds**.
- Base checkout: `61b1c806f28194ed09ae05bdc845fbe9e4e1c5ca` plus the
  working review/CLI/skill changes in this PR.
- Pi SDK: **1.4.0**. Pi and extraction requested **`deepseek-flash`**
  through the official DeepSeek API; Jev requested **`jev-1.13.0`**
  through TypeSafe. The API alias alone does not prove the dated
  `DeepSeek-V4.1-Flash-1017` model identity.
- Task prompt: `Continue processing the full volumes using the
  novel-ontology skill.` The manifest bounded this run to four sections.
- Limits: 90 minutes, 2 recalls and 3 pending revisions per block,
  2,000 command calls; bounded reads and context compaction enabled.

Implementation fixes were made **during** the integration run and exercised
by subsequent real CLI operations. The first ingest began before explicit
non-thinking extraction configuration was compiled; subsequent CLI calls
used it. This is not a pristine fixed-commit benchmark. The portable
`tools/pi-review` packaging was added afterward and validated separately
offline; it has not itself been rerun against paid APIs.

## Observed outcome

**All six assigned blocks applied after Pi review.** This is target
completion, not full-volume completion or full state materialization.

| Block | Chapter index | Processed proposals | Supported applied | Deferred | Reviewed notes | Source lines delivered |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| b0001 | 0 | 382 | 329 | 53 | 48 | 639 |
| b0002 | 1 | 663 | 536 | 127 | 36 | 845 |
| b0003 | 2 | 708 | 566 | 142 | 30 | 1103 |
| b0004 | 3 | 675 | 544 | 131 | 31 | 1293 |
| b0005 | 3 | 668 | 533 | 135 | 51 | 1189 |
| b0006 | 3 | 56 | 50 | 6 | 7 | 137 |
| **Total** | **4 sections** | **3152** | **2558** | **594** | **203** | **5206** |

- Held target blocks: **0**. Unfinished target blocks: **0**.
- **Six current-revision review receipts**, independently checked against
  the final proposal/note hashes and full source-line coverage. They show
  delivery of review material, not proof that Pi understood every fact.
- Structural validator: **0 issues** for the references and invariants it
  checks. Source-language summary heuristic: **0 warnings**. Neither is
  a comprehensive semantic accuracy evaluation.
- Final canonical projection: **93 entities** (34 Characters, 20 Locations,
  10 Organizations, 22 Items, 7 Concepts), **889 events**, **269 scenes**,
  **1288 relation records**.
- **39 audited repairs:** 17 merges, 7 pending proposal revisions,
  4 renames, 5 relation removals, 5 relation additions, 1 name-form addition.
  No recall operation was recorded in this fresh six-block run; recall
  was exercised in the earlier repair attempt and regression tests.
- Pi loaded the concise skill and chose the semantic repairs/reviews.
  The host fixed code invariants, not novel-specific ontology content;
  no host-side semantic edits or forced approvals were used.

Canonical merging exposed overlapping present/mentioned scene lists;
the merge implementation was corrected to keep those lists disjoint.
Pi's subsequent real merges exercised that fix. Deleted identities also
required fresh derived graph rebuilds and stable ID high-water marks so
queries and later blocks did not resurrect or overwrite them.

## What remains incomplete

- The remaining volume 1 data and all of volume 2 were **not run to
  completion**. No full-volume stability claim is made.
- **594 proposals remain deferred** because state-change/alias application
  is not implemented in that apply path. They are not counted as supported
  writes or silently described as a fully merged state simulation.
- Earlier held/failed repair attempts are preserved privately and are
  **not counted as successes**. Their 2-recall/3-revision ceiling was an
  application guard, not a model/API quota. Those defaults can be too low
  for hundreds of proposals; the packaged runner exposes explicit limits.
  Adaptive budgeting has not been implemented or validated.
- This is **one integration pass**, not statistical evidence that every
  future chapter or identity repair will succeed.
- Replay is source-redacted session inspection, not direct frontend chat
  with Pi. Task-local mobile/tunnel integration is not part of this PR.

## Verification

At the end of the live run: CLI regressions **106/106 passed**; local
runtime tests **15/15 passed**; the frontend production build passed with
its existing large-chunk warning. The standalone skill YAML validator was
not run because PyYAML was unavailable; actual Pi skill loading succeeded.

PR packaging verification, without new paid calls:

```sh
npm run build
TMPDIR="$(cd "$TMPDIR" && pwd -P)/" node --test dist/test/*.test.js
npm ci --prefix tools/pi-review --ignore-scripts
npm test --prefix tools/pi-review
git diff --check
```

Results: **106/106 CLI tests**, **22/22 optional review-tool tests**.
The latter include a real offline native-Pi HTML export, secret/source
redaction, portable paths/configurable budgets, missing-key failure before
paid work, existing-writer protection, coverage invalidation, working
ghost projections, honest deferred counts, and structural validation.

The original source files, raw sessions, audit reasons, credentials,
checkpoints, full Pi reports and viewer tokens stay private. This report
was derived from the actual manifest, progress, validation, approval
receipts, maintenance counts and canonical bundle counts; those raw
artifacts are not published. No public tunnel was opened for PR packaging.
