import { join } from "node:path";
import { buildGraphFromBundle } from "../connectors/ladybug.js";
import {
  addCorrection,
  loadCorrections,
  type Correction,
} from "../maintenance/corrections.js";
import {
  addNameForm,
  appendAudit,
  mergeEntities,
  relate,
  removeEntity,
  removeEvent,
  renameEntity,
  unrelate,
} from "../maintenance/fixes.js";
import type { NameForm, RelationType } from "../ontology/types.js";
import { EXTRACTION_CONSTRAINTS_KEY, parseExtractionConstraints } from "../extraction/constraints.js";

export interface FixResult {
  status: "ok";
  op: string;
  novelDir: string;
  detail: unknown;
  graph?: { entities: number; events: number; scenes: number; relations: number; branches: number };
  correction?: Correction;
  corrections?: Correction[];
}

const RELATION_TYPES = new Set([
  "CAUSES", "CAUSED_BY", "PARTICIPATES_IN", "PRESENT_IN", "MENTIONED_IN",
  "LOCATED_AT", "KNOWS", "SPEAKS_TO", "ADDRESSES", "OWNS", "MEMBER_OF",
  "STATE_BEFORE", "STATE_AFTER", "FORKS_FROM", "PRECEDES",
]);

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * `novel fix <op> <novel-dir> ...` — the reviewing agent's pointwise
 * toolkit. Bundle-changing ops rebuild the graph before returning, so
 * the workspace is never left in a bundle/graph skew.
 */
export async function runFix(
  novelDir: string,
  op: string,
  rest: string[],
  opts: { reason?: string; kind?: string; block?: string; key?: string; value?: string } = {},
): Promise<FixResult> {
  const need = (cond: boolean, usage: string) => {
    if (!cond) throw new Error(`Usage: novel fix ${usage}`);
  };
  let detail: unknown;
  let rebuild = true;
  let extra: Partial<FixResult> = {};
  switch (op) {
    case "merge":
      need(rest.length === 2, "merge <novel-dir> <keep-id> <drop-id> [--reason t]");
      detail = await mergeEntities(novelDir, rest[0], rest[1], opts.reason);
      break;
    case "rename":
      need(rest.length === 2, "rename <novel-dir> <entity-id> <new-canonical> [--reason t]");
      detail = await renameEntity(novelDir, rest[0], rest[1], opts.reason);
      break;
    case "add-form":
      need(rest.length === 2, "add-form <novel-dir> <entity-id> <text> [--kind alias|nickname|title] [--reason t]");
      detail = await addNameForm(
        novelDir, rest[0], rest[1],
        (opts.kind as NameForm["kind"]) ?? "alias",
        opts.reason,
      );
      break;
    case "relate":
    case "unrelate": {
      need(rest.length === 3, `${op} <novel-dir> <from-id> <to-id> <TYPE> [--reason t]`);
      if (!RELATION_TYPES.has(rest[2])) {
        throw new Error(`Unknown relation type ${rest[2]}. Valid: ${[...RELATION_TYPES].join(", ")}`);
      }
      const type = rest[2] as RelationType;
      detail = op === "relate"
        ? await relate(novelDir, rest[0], rest[1], type, opts.reason)
        : await unrelate(novelDir, rest[0], rest[1], type, opts.reason);
      break;
    }
    case "remove-entity":
      need(rest.length === 1, "remove-entity <novel-dir> <entity-id> [--reason t]");
      detail = await removeEntity(novelDir, rest[0], opts.reason);
      break;
    case "remove-event":
      need(rest.length === 1, "remove-event <novel-dir> <event-id> [--reason t]");
      detail = await removeEvent(novelDir, rest[0], opts.reason);
      break;
    case "correct": {
      need(!!opts.block && !!opts.key && opts.value !== undefined,
        "correct <novel-dir> --block <blockId> --key <decision-key> --value <json-or-text> [--reason t]");
      const value = parseValue(opts.value!);
      if (opts.key === EXTRACTION_CONSTRAINTS_KEY) parseExtractionConstraints(value);
      const correction = await addCorrection(novelDir, {
        blockId: opts.block!,
        key: opts.key!,
        value,
        reason: opts.reason ?? "",
      });
      await appendAudit(novelDir, "correct", { correctionId: correction.id, blockId: correction.blockId, key: correction.key, value: correction.value }, correction.reason);
      detail = { pinned: `${correction.blockId} ${correction.key} = ${JSON.stringify(correction.value)}` };
      extra = { correction };
      rebuild = false;
      break;
    }
    case "corrections": {
      const corrections = await loadCorrections(novelDir);
      detail = { count: corrections.length };
      extra = { corrections };
      rebuild = false;
      break;
    }
    default:
      throw new Error(
        `Unknown fix op "${op}". Valid: merge, rename, add-form, relate, unrelate, remove-entity, remove-event, correct, corrections.`,
      );
  }
  const graph = rebuild
    ? await buildGraphFromBundle(
        join(novelDir, "ontology"),
        join(novelDir, "ontology", "graph.lbug"),
      )
    : undefined;
  return { status: "ok", op, novelDir, detail, graph, ...extra };
}
