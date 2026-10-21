import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { OntologyStore } from "../ontology/store.js";
import type {
  Branch,
  CharacterStateAtPoint,
  Entity,
  OntEvent,
  Relation,
  Scene,
} from "../ontology/types.js";

export interface BundleManifest {
  novelId: string;
  title: string;
  schemaVersion: number;
  sourceLanguages: string[];
  embeddingModel: string | null;
  embeddingDimension: number | null;
  decisionModel: string; // pinned Jev version
  blocksProcessed: number;
}

/**
 * The portable ontology bundle: plain JSONL files in a per-novel folder.
 * This is the source of truth — shareable by copying the folder, diffable
 * in git, and the input from which the Ladybug hot store is rebuilt.
 *
 *   novels/<novel-id>/
 *     source/            the novel file the user dropped in (unchanged)
 *     ontology/
 *       manifest.json
 *       entities.jsonl  relations.jsonl  events.jsonl
 *       scenes.jsonl    timelines.jsonl  branches.jsonl
 *       graph.lbug      rebuilt from the bundle — disposable
 *     branches/<branch-id>/   delta events + fork-point state snapshot
 *
 * In-memory maps here are a skeleton; large novels stream via appendFile.
 */
export class BundleStore implements OntologyStore {
  private entities = new Map<string, Entity>();
  private events = new Map<string, OntEvent>();
  private scenes = new Map<string, Scene>();
  private relations: Relation[] = [];
  private branches = new Map<string, Branch>();

  constructor(private ontologyDir: string) {}

  async init(manifest: BundleManifest): Promise<void> {
    await mkdir(this.ontologyDir, { recursive: true });
    await writeFile(
      join(this.ontologyDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  private async append(file: string, record: unknown): Promise<void> {
    await appendFile(join(this.ontologyDir, file), JSON.stringify(record) + "\n");
  }

  async upsertEntity(entity: Entity): Promise<void> {
    this.entities.set(entity.id, entity);
    await this.append("entities.jsonl", entity);
  }
  async upsertEvent(event: OntEvent): Promise<void> {
    this.events.set(event.id, event);
    await this.append("events.jsonl", event);
  }
  async upsertScene(scene: Scene): Promise<void> {
    this.scenes.set(scene.id, scene);
    await this.append("scenes.jsonl", scene);
  }
  async addRelation(relation: Relation): Promise<void> {
    this.relations.push(relation);
    await this.append("relations.jsonl", relation);
  }
  async createBranch(branch: Branch): Promise<void> {
    this.branches.set(branch.id, branch);
    await this.append("branches.jsonl", branch);
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.entities.get(id) ?? null;
  }
  async findByName(text: string): Promise<Entity[]> {
    const hits: Entity[] = [];
    for (const e of this.entities.values()) {
      if (e.names.some((n) => n.text === text || text.includes(n.text))) hits.push(e);
    }
    return hits;
  }
  async traverse(): Promise<Entity[]> {
    throw new Error("BundleStore is the write/sync layer; traverse via LadybugStore.");
  }
  async searchText(): Promise<Entity[]> {
    throw new Error("Use LadybugStore FTS index for text search.");
  }
  async searchVector(): Promise<Entity[]> {
    throw new Error("Use LadybugStore vector index for similarity search.");
  }
  async getStateAt(): Promise<CharacterStateAtPoint | null> {
    throw new Error("State folding is implemented over the Ladybug event stream.");
  }
  async listEvents(timelineId: string, minImportance: number): Promise<OntEvent[]> {
    return [...this.events.values()].filter(
      (e) => e.timelineId === timelineId && e.importance >= minImportance,
    );
  }

  /** Read a JSONL file back into memory (used by `novel graph build`). */
  async loadFile<T>(file: string): Promise<T[]> {
    try {
      const raw = await readFile(join(this.ontologyDir, file), "utf8");
      return raw
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
  }
}
