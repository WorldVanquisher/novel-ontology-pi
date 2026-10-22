import { stat } from "node:fs/promises";
import { join } from "node:path";
import { BundleStore } from "../connectors/bundle.js";
import { jevFromEnv } from "../connectors/jev.js";
import { resolveJevKey } from "../connectors/secrets.js";
import { loadChangeSet } from "../merge/changesetStore.js";
import {
  checkMatches,
  nominateMatchCandidates,
  type MatchVerdict,
} from "../matching/entityMatch.js";
import type { Entity, OntEvent } from "../ontology/types.js";

export interface MatchPacket {
  status: "ok";
  novelDir: string;
  scope: string;
  candidates: number;
  confident: (MatchVerdict & { suggestedFix: string })[];
  uncertain: (MatchVerdict & { suggestedFix: string })[];
  rejected: MatchVerdict[];
  distinct: MatchVerdict[];
}

/**
 * `novel match <novel-dir> [--changeset <id>]` — the entity-matching
 * review packet for the merge gate: code nominates duplicate pairs,
 * System 1 (Jev) reviews the batch with its checklist, and only the
 * pairs it cannot settle are raised to the main agent.
 */
export async function runMatch(
  novelDir: string,
  opts: { changesetId?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<MatchPacket> {
  const env = opts.env ?? process.env;
  const ontologyDir = join(novelDir, "ontology");
  try {
    await stat(join(ontologyDir, "manifest.json"));
  } catch {
    throw new Error(
      `No novel workspace manifest at ${join(ontologyDir, "manifest.json")}. Run \`novel init ${novelDir}\` first.`,
    );
  }
  if (!resolveJevKey(env)?.key) {
    throw new Error(
      "Jev API key missing — the matching checklist is a System 1 review and needs it. Run `novel jev login`, set TYPESAFE_API_KEY, or set JEV_API_KEY_ENV to the name of an env var that holds it.",
    );
  }

  const bundle = new BundleStore(ontologyDir);
  const rows = await bundle.loadFile<Entity>("entities.jsonl");
  const byId = new Map<string, Entity>();
  for (const e of rows) byId.set(e.id, e);
  let scope = "workspace";
  if (opts.changesetId) {
    scope = `changeset ${opts.changesetId}`;
    const cs = await loadChangeSet(novelDir, opts.changesetId);
    if (!cs) throw new Error(`No changeset ${opts.changesetId} in ${novelDir}.`);
    // At review time the changeset's entities may not be merged yet:
    // they join the matching universe as proposed records.
    for (const p of cs.status === "approved" ? [] : cs.proposals) {
      if (p.kind !== "upsert_entity") continue;
      const payload = p.payload as Partial<Entity>;
      if (payload.id && payload.names && !byId.has(payload.id)) {
        byId.set(payload.id, payload as Entity);
      }
    }
  }
  const entities = [...byId.values()];
  const events = await bundle.loadFile<OntEvent>("events.jsonl");

  let candidates = nominateMatchCandidates(entities);
  if (opts.changesetId) {
    const cs = await loadChangeSet(novelDir, opts.changesetId);
    const proposedIds = new Set(
      (cs?.proposals ?? [])
        .filter((p) => p.kind === "upsert_entity")
        .map((p) => (p.payload as Partial<Entity>).id)
        .filter(Boolean),
    );
    candidates = candidates.filter(
      (c) => proposedIds.has(c.aId) || proposedIds.has(c.bId),
    );
  }

  const verdicts = await checkMatches(jevFromEnv(env), candidates, entities, events);
  const withFix = (v: MatchVerdict) => ({
    ...v,
    suggestedFix: `novel fix merge ${novelDir} ${v.keepId} ${v.dropId}`,
  });
  return {
    status: "ok",
    novelDir,
    scope,
    candidates: verdicts.length,
    confident: verdicts.filter((v) => v.verdict === "confident").map(withFix),
    uncertain: verdicts.filter((v) => v.verdict === "uncertain").map(withFix),
    rejected: verdicts.filter((v) => v.verdict === "rejected"),
    distinct: verdicts.filter((v) => v.verdict === "distinct"),
  };
}
