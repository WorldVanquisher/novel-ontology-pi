import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectProcessingEvent,
  type ProcessingEvent,
} from "../apps/playground/src/events/project.js";

/**
 * The playground's live projection: CLI ProcessingEvents (transport
 * facts) -> PlaygroundEvents (view contract). The CLI stream is the
 * source of truth; this mapping is the only place the two meet.
 */

test("block progress maps 1:1", () => {
  assert.deepEqual(projectProcessingEvent({ type: "block.started", blockId: "b0007" }), [
    { type: "block.started", blockId: "b0007", label: "Block b0007" },
  ]);
  assert.deepEqual(
    projectProcessingEvent({ type: "sectioned", blockId: "b0007", sentences: 512 }),
    [{ type: "sectioned", blockId: "b0007", sentences: 512 }],
  );
});

test("a proposal becomes a decision-feed verdict, never a fabricated ghost node", () => {
  const out = projectProcessingEvent({
    type: "proposal.added",
    changesetId: "cs_b0007",
    proposal: {
      id: "b0007_newchar_0",
      kind: "upsert_entity",
      confidence: 0.93,
      provenance: { blockId: "b0007", sentenceIds: ["s1", "s2"], patchId: "name-detector" },
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "verdict");
  if (out[0].type === "verdict") {
    assert.equal(out[0].patch, "name-detector");
    assert.match(out[0].text, /upsert_entity/);
    assert.match(out[0].text, /93%/);
  }
});

test("gate events keep the queue truthful", () => {
  assert.deepEqual(
    projectProcessingEvent({
      type: "changeset.pending",
      changesetId: "cs_b0007",
      proposalIds: ["p1", "p2"],
    }),
    [
      {
        type: "changeset.pending",
        changesetId: "cs_b0007",
        label: "ChangeSet cs_b0007",
        nodeIds: ["p1", "p2"],
      },
    ],
  );
  assert.deepEqual(
    projectProcessingEvent({
      type: "changeset.held",
      changesetId: "cs_b0007",
      proposalIds: ["p1"],
    }),
    [{ type: "changeset.held", changesetId: "cs_b0007", nodeIds: ["p1"] }],
  );
  const approved = projectProcessingEvent({
    type: "changeset.approved",
    changesetId: "cs_b0007",
    proposalIds: [],
  });
  assert.equal(approved[0].type, "verdict");
  const applied = projectProcessingEvent({
    type: "changeset.applied",
    changesetId: "cs_b0007",
    target: "store",
    processed: 3,
    unsupportedProposalIds: ["p9"],
  });
  assert.equal(applied[0].type, "verdict");
  if (applied[0].type === "verdict") assert.match(applied[0].text, /3 proposals · 1 deferred/);
});

test("merge + rebuild map; accumulating noise is dropped", () => {
  assert.deepEqual(
    projectProcessingEvent({ type: "changeset.merged", changesetId: "cs_b0007", target: "store" }),
    [{ type: "changeset.merged", changesetId: "cs_b0007" }],
  );
  assert.deepEqual(
    projectProcessingEvent({
      type: "graph.rebuilt",
      counts: { entities: 4, events: 0, scenes: 0, relations: 0, branches: 0 },
    } satisfies ProcessingEvent),
    [{ type: "graph.rebuilt" }],
  );
  assert.deepEqual(
    projectProcessingEvent({
      type: "changeset.accumulating",
      changesetId: "cs_b0007",
      proposalIds: [],
    }),
    [],
  );
});
