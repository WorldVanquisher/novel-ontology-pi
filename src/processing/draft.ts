import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DialogueTurn } from "../ontology/types.js";
import type { ChangeProposal } from "../merge/changeset.js";

export interface WorkingDraft {
  version: 1;
  blockId: string;
  chapterIndex: number;
  stage: "miniloop" | "extraction" | "gate";
  patchId: string;
  updatedAt: string;
  proposals: ChangeProposal[];
  sceneSpans: string[][];
  dialogueUnits: string[][];
  turns: DialogueTurn[];
  completedScenes: number;
  totalScenes: number;
}

export async function saveWorkingDraft(novelDir: string, draft: WorkingDraft): Promise<void> {
  if (!/^b[0-9]+$/.test(draft.blockId)) throw new Error("Invalid draft block ID");
  const directory = join(novelDir, "working");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = join(directory, `${draft.blockId}.json`);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(draft), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
