import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeSet, ChangeSetStatus } from "./changeset.js";

/**
 * ChangeSet persistence — the merge gate's filing cabinet.
 *
 * The miniloop writes one JSON file per block into
 * `<novelDir>/changesets/<changeset-id>.json`; the main agent reviews
 * through the CLI (`novel changeset list|show|approve|hold`), and only an
 * approved ChangeSet is applied (merge/apply.ts refuses anything else).
 * Status changes are recorded back to the same file, so the folder is
 * the complete audit trail of the gate.
 */

export function changesetDir(novelDir: string): string {
  return join(novelDir, "changesets");
}

export async function saveChangeSet(
  novelDir: string,
  cs: ChangeSet,
): Promise<string> {
  const dir = changesetDir(novelDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${cs.id}.json`);
  await writeFile(path, JSON.stringify(cs, null, 2));
  return path;
}

export async function loadChangeSet(
  novelDir: string,
  id: string,
): Promise<ChangeSet> {
  const raw = await readFile(join(changesetDir(novelDir), `${id}.json`), "utf8");
  return JSON.parse(raw) as ChangeSet;
}

export async function listChangeSets(novelDir: string): Promise<ChangeSet[]> {
  let files: string[];
  try {
    files = await readdir(changesetDir(novelDir));
  } catch {
    return [];
  }
  const out: ChangeSet[] = [];
  for (const f of files.filter((x) => x.endsWith(".json")).sort()) {
    out.push(
      JSON.parse(
        await readFile(join(changesetDir(novelDir), f), "utf8"),
      ) as ChangeSet,
    );
  }
  return out;
}

/** Record a gate decision (approve / hold / revision_requested) on disk. */
export async function setChangeSetStatus(
  novelDir: string,
  id: string,
  status: ChangeSetStatus,
  notes?: Record<string, string>,
): Promise<ChangeSet> {
  const cs = await loadChangeSet(novelDir, id);
  cs.status = status;
  if (notes) cs.reviewNotes = { ...cs.reviewNotes, ...notes };
  await saveChangeSet(novelDir, cs);
  return cs;
}
