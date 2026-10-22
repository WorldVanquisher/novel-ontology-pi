import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Corrections — the recall protocol's memory (sector 09).
 *
 * When the reviewing agent traces a cascade of wrong proposals back
 * to one early System 1 decision, it does not argue with the loop: it
 * PINS that decision. A correction names a block and a decision key
 * (the same keys the patches ask with — `boundary:<sentenceId>`,
 * `present:<entityId>`, `speaker:<n>`, …) and the value the decision
 * must take. On the next (re)run of that block the miniloop honors
 * the pin instead of re-deciding, and the override is visible in the
 * run's result. Corrections persist in the workspace so a recall can
 * happen in a later session, by a later agent.
 */
export interface Correction {
  id: string;
  blockId: string;
  /** Decision key, exactly as the patch asks it. */
  key: string;
  /** The pinned answer value (number for noul, string for choice). */
  value: unknown;
  reason: string;
  createdAt: string;
}

export function correctionsPath(novelDir: string): string {
  return join(novelDir, "corrections.json");
}

export async function loadCorrections(novelDir: string): Promise<Correction[]> {
  try {
    const raw = await readFile(correctionsPath(novelDir), "utf8");
    const parsed = JSON.parse(raw) as Correction[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function addCorrection(
  novelDir: string,
  input: { blockId: string; key: string; value: unknown; reason: string },
): Promise<Correction> {
  const all = await loadCorrections(novelDir);
  const correction: Correction = {
    id: `corr_${String(all.length + 1).padStart(4, "0")}`,
    blockId: input.blockId,
    key: input.key,
    value: input.value,
    reason: input.reason,
    createdAt: new Date().toISOString(),
  };
  // A re-pin of the same decision replaces the old one: the latest
  // diagnosis wins, and the file stays the single source of truth.
  const kept = all.filter(
    (c) => !(c.blockId === correction.blockId && c.key === correction.key),
  );
  kept.push(correction);
  await mkdir(novelDir, { recursive: true });
  await writeFile(correctionsPath(novelDir), JSON.stringify(kept, null, 2) + "\n");
  return correction;
}

/** Pins for one block, as the miniloop consumes them: key -> value. */
export function pinsForBlock(
  corrections: Correction[],
  blockId: string,
): Map<string, unknown> {
  return new Map(
    corrections.filter((c) => c.blockId === blockId).map((c) => [c.key, c.value]),
  );
}
