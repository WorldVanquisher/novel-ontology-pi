import type { WorkModel } from "../connectors/llm.js";
import type { MiniloopResult } from "../autostep/miniloop.js";
import type { CandidateNomination, NameScanHit } from "../autostep/patches/name-detector.js";
import type { ChangeProposal } from "../merge/changeset.js";
import type {
  Entity,
  EntityKind,
  EventType,
  NameForm,
  OntEvent,
  Relation,
  Scene,
} from "../ontology/types.js";
import type { Sentence } from "../text/sectioning.js";

/**
 * Sector 08 — extraction: from structured scenes to ontology.
 *
 * The work LLM reads ONE structured scene at a time (span + decided
 * cast + attributed turns + graph context) and describes its events in
 * English-canonical JSON. Everything after the call is deterministic:
 * name resolution, ID minting, validation, and proposal assembly
 * happen here, never in the model.
 *
 * Design defaults honored (decision sheet, sector 08):
 *  - event granularity is the model's call, soft target 3–5 per scene;
 *  - CAUSES edges originate here (no Jev pre-pass in v1);
 *  - state deltas carry all six dimensions (emotions, knowledge,
 *    goals, relationships, location, possessions) as set_state_change
 *    proposals — gate-visible; the fold into state-at-a-point is
 *    sector 12's work, and apply treats them as deferred until then;
 *  - NO model self-reported confidence: extraction proposals carry
 *    EXTRACTION_CONFIDENCE, a policy constant. The merge gate is the
 *    fidelity check (it spotlights new entities + these proposals).
 *
 * Name flow (sector 04): stubs the name patch proposed
 * (upsert_entity with a candidateName payload) are FLESHED OUT here —
 * replaced by full entity proposals when extraction confirms the
 * character, dropped with a review note when it does not. add_alias
 * proposals are folded into upsert_entity name lists, as apply.ts
 * requires. A participant name that resolves to nothing known is
 * minted as a new entity and NOTED as extraction-originated (never
 * Jev-judged) so the gate can scrutinize it.
 */
export const EXTRACTION_CONFIDENCE = 0.7;
export const CANON_TIMELINE_ID = "tl_canon";

export interface ExtractionInput {
  blockId: string;
  chapterIndex: number;
  sentences: Sentence[];
  miniloop: MiniloopResult;
  knownEntities: Entity[];
  /** The block's ChangeSet proposals as the miniloop left them. */
  proposals: ChangeProposal[];
  /** Distinct entity/event/scene counts already in the bundle. */
  counts: { events: number; scenes: number };
}

export interface ExtractionOutput {
  proposals: ChangeProposal[];
  /** Review notes keyed by proposal id (or a synthetic extraction key). */
  notes: Record<string, string>;
}

interface LlmStateChange {
  character?: string;
  emotions?: Record<string, number>;
  knowledgeAdd?: string[];
  goalsAdd?: string[];
  relationships?: Record<string, number>;
  location?: string | null;
  possessionsAdd?: string[];
  possessionsRemove?: string[];
}

interface LlmEvent {
  summaryEn?: string;
  eventType?: string;
  importance?: number;
  actors?: string[];
  affected?: string[];
  evidence?: string[];
  causes?: number | null;
  stateChanges?: LlmStateChange[];
}

interface LlmScene {
  locationName?: string | null;
  events?: LlmEvent[];
  newEntities?: { name?: string; kind?: string; aliases?: { text?: string; kind?: string }[] }[];
}

export const EXTRACTION_SYSTEM = `You are the extraction step of a novel-ontology pipeline. You receive ONE structured scene from a novel: its sentences (with stable ids), the characters the system already knows, and dialogue turns attributed by a decision model. You output ONLY a JSON object describing the scene's ontology: events, participants, causal links, character state changes, and any genuinely new entities.

Rules:
- Semantics are English-canonical: every summary is in English, regardless of the novel's language. Names stay in their original surface form, copied exactly from the text.
- Reference characters ONLY by name forms that appear in the scene text or the known-cast list. Never invent an id.
- Extract 3-5 events for the scene (fewer if the scene is genuinely smaller). An event is something that happens or is revealed — not a mood, not pure description.
- Evidence: each event lists the ids of the sentences that directly support it, copied from the scene's sentence list. Never invent sentence ids.
- Causality: an event's "causes" is the 0-based index, within your events array, of an earlier event in this scene that directly causes it, or null. Only when the text supports a direct causal link.
- State changes: only changes the text actually shows — emotions (deltas -1..1), knowledge gained (short English facts), goals gained, relationship shifts toward another named character (-1..1), a location the character ends up in, possessions gained or lost.
- New entities: people, places, organizations, or significant items in this scene that are NOT in the known-cast list. Give the fullest name form used in the text, plus any alias/nickname/title forms used for them in this scene.
- locationName: the original-form name of the place the scene happens in, if the text establishes one, else null.
- Output JSON only, in exactly the shape requested. No commentary.`;

export function buildScenePrompt(input: {
  sceneIndex: number;
  chapterIndex: number;
  sentences: Sentence[];
  cast: { id: string; forms: string[] }[];
  turns: { speakerId: string | null; sentenceIds: string[] }[];
  pendingCandidates: string[];
}): string {
  const castLines = input.cast.length
    ? input.cast.map((c) => `- ${c.id} — ${c.forms.join(" / ")}`).join("\n")
    : "(none known yet)";
  const turnLines = input.turns.length
    ? input.turns
        .map((t) => `- sentences ${t.sentenceIds.join(", ")} — speaker: ${t.speakerId ?? "unknown"}`)
        .join("\n")
    : "(no dialogue turns decided)";
  const sentenceLines = input.sentences.map((s) => `${s.id}: ${s.text}`).join("\n");
  return [
    `SCENE ${input.sceneIndex} (chapter ${input.chapterIndex})`,
    `KNOWN CAST (id — name forms):\n${castLines}`,
    input.pendingCandidates.length
      ? `NEW-NAME CANDIDATES a decision model judged likely new (if they appear, describe them under newEntities): ${input.pendingCandidates.join(", ")}`
      : "",
    `DIALOGUE TURNS:\n${turnLines}`,
    `SENTENCES:\n${sentenceLines}`,
    `Respond with JSON of exactly this shape:
{"locationName": string|null, "events": [{"summaryEn": string, "eventType": "dialogue"|"action"|"revelation"|"conflict"|"movement"|"decision"|"introduction"|"resolution"|"other", "importance": number 0..1, "actors": [name forms], "affected": [name forms], "evidence": [sentence ids], "causes": number|null, "stateChanges": [{"character": name form, "emotions": {string: number}, "knowledgeAdd": [string], "goalsAdd": [string], "relationships": {name form: number}, "location": string|null, "possessionsAdd": [string], "possessionsRemove": [string]}]}], "newEntities": [{"name": string, "kind": "Character"|"Location"|"Organization"|"Item"|"Concept", "aliases": [{"text": string, "kind": "alias"|"nickname"|"title"}]}]}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export const REFINER_SYSTEM = `You extract person names from isolated text spans. You receive numbered spans, each with the single sentence it came from. You know nothing about the story and must not guess beyond the sentence. For each span, reply with the fullest person-name form the span refers to (a partial or suffixed form expanded to the full name as written in the sentence), or NONE if the span is not a person. Output one line per span: N: <name or NONE>. Nothing else.`;

/**
 * The zero-context candidate refiner (sector 04): one work-LLM call
 * per block, carrying ONLY the nominated spans and their sentences —
 * no accumulated story context, so nothing biases it toward an
 * existing character. Unparseable items keep their raw span; Jev is
 * still the judge of every candidate that comes out of here.
 */
export function createCandidateRefiner(work: WorkModel) {
  return async (
    nominations: CandidateNomination[],
    sentences: Sentence[],
  ): Promise<string[]> => {
    if (nominations.length === 0) return [];
    const byId = new Map(sentences.map((s) => [s.id, s.text]));
    const listing = nominations
      .map((n, i) => `${i + 1}. span: 「${n.span}」 sentence: ${byId.get(n.sentenceId) ?? ""}`)
      .join("\n");
    try {
      const raw = await work.generate({
        system: REFINER_SYSTEM,
        prompt: listing,
        maxTokens: 800,
      });
      const refined = new Map<number, string | null>();
      for (const line of raw.split("\n")) {
        const m = line.match(/^\s*(\d+)\s*[:：]\s*(.+?)\s*$/);
        if (!m) continue;
        const idx = Number(m[1]) - 1;
        const value = m[2].replace(/^「|」$/g, "");
        // NONE is a verdict (drop the span); a missing line is a parse
        // gap and keeps the raw span for Jev to judge.
        if (value) refined.set(idx, value === "NONE" ? null : value);
      }
      const out: string[] = [];
      nominations.forEach((n, i) => {
        const v = refined.has(i) ? refined.get(i) : n.span;
        if (v && !out.includes(v)) out.push(v);
      });
      return out;
    } catch {
      // Refinement is an optimization; the raw spans still get judged.
      return nominations.map((n) => n.span);
    }
  };
}

const KIND_PREFIX: Record<string, string> = {
  Character: "char",
  Location: "loc",
  Organization: "org",
  Item: "item",
  Concept: "concept",
};
const EVENT_TYPES = new Set<string>([
  "dialogue", "action", "revelation", "conflict", "movement",
  "decision", "introduction", "resolution", "other",
]);

function guessLang(text: string): string {
  if (/[぀-ヿ]/.test(text)) return "ja";
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[A-Za-z]/.test(text)) return "en";
  return "und";
}

function parseSceneJson(raw: string): LlmScene | null {
  const cleaned = raw.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as LlmScene;
  } catch {
    return null;
  }
}

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
const clampDelta = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(-1, v)) : 0;
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/**
 * Builds the BlockProcessor extraction step backed by a WorkModel.
 * Sequential per scene: entities minted in scene N are known cast for
 * scene N+1 of the same block, which is what the design means by
 * "relevant graph context".
 */
export function createExtractor(work: WorkModel) {
  return async (input: ExtractionInput): Promise<ExtractionOutput> => {
    const notes: Record<string, string> = {};
    const sentenceById = new Map(input.sentences.map((s) => [s.id, s]));
    const spans =
      (input.miniloop.accepted["sceneSpans"] as string[][] | undefined)?.filter(
        (sp) => sp.length > 0,
      ) ?? [];
    const sceneSpans = spans.length ? spans : [input.sentences.map((s) => s.id)];
    const nameHits = (input.miniloop.accepted["nameHits"] as NameScanHit[] | undefined) ?? [];

    // --- name resolution state (grows as scenes mint entities) ---
    const entityById = new Map<string, Entity>();
    const formToId = new Map<string, string>();
    for (const e of input.knownEntities) {
      entityById.set(e.id, e);
      for (const n of e.names) formToId.set(n.text, e.id);
    }
    const suffixBase = new Map<string, number>();
    for (const e of input.knownEntities) {
      const m = e.id.match(/^([a-z]+)_(\d+)$/);
      if (m) suffixBase.set(m[1], Math.max(suffixBase.get(m[1]) ?? 0, Number(m[2])));
    }
    const mintEntity = (name: string, kind: EntityKind, aliases: NameForm[]): Entity => {
      const prefix = KIND_PREFIX[kind] ?? "char";
      const next = (suffixBase.get(prefix) ?? 0) + 1;
      suffixBase.set(prefix, next);
      const entity: Entity = {
        id: `${prefix}_${String(next).padStart(6, "0")}`,
        kind,
        names: [
          { text: name, lang: guessLang(name), kind: "canonical" },
          ...aliases.filter((a) => a.text !== name),
        ],
        properties: {},
        confidence: EXTRACTION_CONFIDENCE,
      };
      entityById.set(entity.id, entity);
      for (const n of entity.names) formToId.set(n.text, entity.id);
      return entity;
    };

    // --- partition the miniloop's proposals ---
    const stubs = input.proposals.filter(
      (p) => p.kind === "upsert_entity" && (p.payload as { needsExtraction?: boolean }).needsExtraction,
    );
    const stubByCandidate = new Map<string, ChangeProposal>();
    for (const s of stubs) {
      stubByCandidate.set((s.payload as { candidateName: string }).candidateName, s);
    }
    const aliasProposals = input.proposals.filter((p) => p.kind === "add_alias");
    const otherProposals = input.proposals.filter(
      (p) => !stubs.includes(p) && !aliasProposals.includes(p),
    );

    // --- proposal buckets, composed at the end ---
    const entityUpserts = new Map<string, ChangeProposal>();
    const sceneProposals: ChangeProposal[] = [];
    const eventProposals: ChangeProposal[] = [];
    const relationProposals: ChangeProposal[] = [];
    const stateProposals: ChangeProposal[] = [];

    const upsertFor = (entity: Entity, proposal: ChangeProposal): void => {
      if (!entityUpserts.has(entity.id)) entityUpserts.set(entity.id, proposal);
    };
    /** Resolve a name form to an entity, minting (and noting) if new. */
    const resolveOrMint = (
      name: string,
      kind: EntityKind,
      aliases: NameForm[],
      origin: string,
    ): Entity => {
      const known = formToId.get(name);
      if (known) return entityById.get(known)!;
      const entity = mintEntity(name, kind, aliases);
      const stub = stubByCandidate.get(name);
      if (stub) {
        // A Jev-judged candidate, confirmed by use: the stub becomes
        // the full entity, keeping its proposal id and Jev confidence.
        upsertFor(entity, { ...stub, payload: entity });
        stubByCandidate.delete(name);
        return entity;
      }
      upsertFor(entity, {
        id: `${input.blockId}_mint_${entity.id}`,
        kind: "upsert_entity",
        payload: entity,
        confidence: EXTRACTION_CONFIDENCE,
        provenance: { blockId: input.blockId, sentenceIds: [], patchId: "extraction" },
      });
      notes[`extraction:new-entity:${entity.id}`] =
        `${origin}: "${name}" was minted by extraction without a Jev new-name judgment — the gate should scrutinize this identity.`;
      return entity;
    };

    let eventSeq = input.counts.events;
    let sceneSeq = input.counts.scenes;

    for (let si = 0; si < sceneSpans.length; si++) {
      const spanIds = sceneSpans[si];
      const spanSentences = spanIds
        .map((id) => sentenceById.get(id))
        .filter((s): s is Sentence => !!s);
      if (spanSentences.length === 0) continue;
      const sceneId = `scene_${String(++sceneSeq).padStart(6, "0")}`;

      // Cast: scan hits inside the span + presence from covering windows.
      const castIds = new Set<string>();
      const mentionedIds = new Set<string>();
      for (const h of nameHits) if (spanIds.includes(h.sentenceId)) castIds.add(h.entityId);
      for (const w of input.miniloop.windows) {
        if (!w.sentenceIds.some((id) => spanIds.includes(id))) continue;
        for (const id of w.charactersPresent) castIds.add(id);
        for (const id of w.charactersMentioned) mentionedIds.add(id);
      }
      const turns = input.miniloop.windows
        .flatMap((w) => w.turns)
        .filter((t) => t.sentenceIds.some((id) => spanIds.includes(id)));

      let llm: LlmScene | null = null;
      try {
        const raw = await work.generate({
          system: EXTRACTION_SYSTEM,
          prompt: buildScenePrompt({
            sceneIndex: si + 1,
            chapterIndex: input.chapterIndex,
            sentences: spanSentences,
            cast: [...castIds].map((id) => ({
              id,
              forms: (entityById.get(id)?.names ?? []).map((n) => n.text),
            })),
            turns,
            pendingCandidates: [...stubByCandidate.keys()],
          }),
          jsonSchema: { type: "object" },
          maxTokens: 4000,
        });
        llm = parseSceneJson(raw);
        if (!llm) notes[`extraction:scene:${sceneId}`] = "Work model returned unparseable JSON; scene contributed no proposals.";
      } catch (err) {
        notes[`extraction:scene:${sceneId}`] = `Work model call failed: ${(err as Error).message.slice(0, 160)}`;
      }
      if (!llm) continue;

      // Register the model's declared new entities first, so event
      // actors resolve to them (and to stubs they flesh out).
      for (const ne of llm.newEntities ?? []) {
        if (!ne.name) continue;
        const kind = (Object.keys(KIND_PREFIX).includes(ne.kind ?? "")
          ? ne.kind
          : "Character") as EntityKind;
        const aliasForms = (ne.aliases ?? []).filter((a) => a.text);
        const aliases: NameForm[] = aliasForms.map((a) => ({
          text: a.text!,
          lang: guessLang(a.text!),
          kind: (["alias", "nickname", "title"].includes(a.kind ?? "")
            ? a.kind
            : "alias") as NameForm["kind"],
        }));
        // Identity check across ALL declared forms, not just the
        // canonical name: a "new" entity whose alias is already known
        // IS that entity (e.g. canonical 食蜂 with alias 食蜂操祈).
        // Fold any missing forms into an upsert for it instead of
        // minting a duplicate.
        const declaredForms = [ne.name, ...aliases.map((a) => a.text)];
        const existingId = declaredForms
          .map((f) => formToId.get(f))
          .find((id) => id !== undefined);
        if (existingId) {
          const base = entityById.get(existingId)!;
          const missing = declaredForms.filter(
            (f) => !base.names.some((n) => n.text === f),
          );
          if (missing.length > 0) {
            const foldedForms: NameForm[] = missing.map((text, i) => ({
              text,
              lang: guessLang(text),
              kind: i === 0 && text === ne.name ? "alias" : (aliases.find((a) => a.text === text)?.kind ?? "alias"),
            }));
            const existingUpsert = entityUpserts.get(existingId);
            if (existingUpsert) {
              const payload = existingUpsert.payload as Entity;
              payload.names = [...payload.names, ...foldedForms];
            } else {
              entityUpserts.set(existingId, {
                id: `${input.blockId}_forms_${existingId}`,
                kind: "upsert_entity",
                payload: { ...base, names: [...base.names, ...foldedForms] },
                confidence: EXTRACTION_CONFIDENCE,
                provenance: { blockId: input.blockId, sentenceIds: spanIds, patchId: "extraction" },
              });
            }
            for (const f of declaredForms) formToId.set(f, existingId);
          }
          continue;
        }
        const entity = mintEntity(ne.name, kind, aliases);
        const stub = stubByCandidate.get(ne.name);
        if (stub) {
          // Extraction confirms the name patch's candidate: the stub
          // becomes the full entity, keeping its id and Jev confidence.
          upsertFor(entity, { ...stub, payload: entity });
          stubByCandidate.delete(ne.name);
        } else {
          upsertFor(entity, {
            id: `${input.blockId}_mint_${entity.id}`,
            kind: "upsert_entity",
            payload: entity,
            confidence: EXTRACTION_CONFIDENCE,
            provenance: { blockId: input.blockId, sentenceIds: spanIds, patchId: "extraction" },
          });
          notes[`extraction:new-entity:${entity.id}`] =
            `Declared in extraction's newEntities for scene ${sceneId} without a Jev new-name judgment — the gate should scrutinize this identity.`;
        }
      }

      // Location: resolve or mint a Location entity.
      let locationId: string | null = null;
      if (llm.locationName) {
        const loc = resolveOrMint(llm.locationName, "Location", [], `Scene ${sceneId} location`);
        locationId = loc.id;
      }

      // Events, in the model's order; CAUSES refers back by the
      // model's own event index, mapped to minted ids (skipped model
      // events never enter the map, so indices cannot misalign).
      const llmIndexToEventId = new Map<number, string>();
      const llmEvents = llm.events ?? [];
      for (let ei = 0; ei < llmEvents.length; ei++) {
        const le = llmEvents[ei];
        if (!le.summaryEn) continue;
        const eventId = `evt_${String(++eventSeq).padStart(6, "0")}`;
        llmIndexToEventId.set(ei, eventId);
        const actorIds = strList(le.actors).map(
          (name) => resolveOrMint(name, "Character", [], `Actor of event ${eventId}`).id,
        );
        const affectedIds = strList(le.affected).map(
          (name) => resolveOrMint(name, "Character", [], `Affected by event ${eventId}`).id,
        );
        for (const id of [...actorIds, ...affectedIds]) castIds.add(id);
        const evidenceIds = strList(le.evidence).filter((id) => spanIds.includes(id));
        const evidence = evidenceIds.length
          ? evidenceIds
          : [spanIds[0]];
        const event: OntEvent = {
          id: eventId,
          timelineId: CANON_TIMELINE_ID,
          chapterIndex: input.chapterIndex,
          chronologicalOrder: eventSeq,
          eventType: (EVENT_TYPES.has(le.eventType ?? "") ? le.eventType : "other") as EventType,
          summaryEn: le.summaryEn,
          evidence: {
            text: sentenceById.get(evidence[0])?.text ?? "",
            sentenceIds: evidence,
          },
          importance: clamp01(le.importance, 0.5),
          primaryActors: actorIds,
          affectedCharacters: affectedIds,
          confidence: EXTRACTION_CONFIDENCE,
        };
        eventProposals.push({
          id: `${input.blockId}_${eventId}`,
          kind: "create_event",
          payload: event,
          confidence: EXTRACTION_CONFIDENCE,
          provenance: { blockId: input.blockId, sentenceIds: evidence, patchId: "extraction" },
        });
        for (const actorId of actorIds) {
          const rel: Relation = {
            fromId: actorId,
            toId: eventId,
            type: "PARTICIPATES_IN",
            properties: {},
            confidence: EXTRACTION_CONFIDENCE,
          };
          relationProposals.push({
            id: `${input.blockId}_${eventId}_part_${actorId}`,
            kind: "add_relation",
            payload: rel,
            confidence: EXTRACTION_CONFIDENCE,
            provenance: { blockId: input.blockId, sentenceIds: evidence, patchId: "extraction" },
          });
        }
        const causeId =
          typeof le.causes === "number" ? llmIndexToEventId.get(le.causes) : undefined;
        if (causeId && causeId !== eventId) {
          const rel: Relation = {
            fromId: causeId,
            toId: eventId,
            type: "CAUSES",
            properties: {},
            confidence: EXTRACTION_CONFIDENCE,
          };
          relationProposals.push({
            id: `${input.blockId}_${eventId}_causes`,
            kind: "add_relation",
            payload: rel,
            confidence: EXTRACTION_CONFIDENCE,
            provenance: { blockId: input.blockId, sentenceIds: evidence, patchId: "extraction" },
          });
        }
        for (const sc of le.stateChanges ?? []) {
          if (!sc.character) continue;
          const character = resolveOrMint(sc.character, "Character", [], `State change in event ${eventId}`);
          const relationships: Record<string, number> = {};
          for (const [name, v] of Object.entries(sc.relationships ?? {})) {
            const target = formToId.get(name);
            if (target) relationships[target] = clampDelta(v);
          }
          stateProposals.push({
            id: `${input.blockId}_${eventId}_state_${character.id}`,
            kind: "set_state_change",
            payload: {
              characterId: character.id,
              afterEventId: eventId,
              emotions: Object.fromEntries(
                Object.entries(sc.emotions ?? {}).map(([k, v]) => [k, clampDelta(v)]),
              ),
              knowledgeAdd: strList(sc.knowledgeAdd),
              goalsAdd: strList(sc.goalsAdd),
              relationships,
              location: sc.location ?? null,
              possessionsAdd: strList(sc.possessionsAdd),
              possessionsRemove: strList(sc.possessionsRemove),
            },
            confidence: EXTRACTION_CONFIDENCE,
            provenance: { blockId: input.blockId, sentenceIds: evidence, patchId: "extraction" },
          });
        }
      }

      const scene: Scene = {
        id: sceneId,
        chapterIndex: input.chapterIndex,
        sentenceIds: spanIds,
        charactersPresent: [...castIds],
        charactersMentioned: [...mentionedIds].filter((id) => !castIds.has(id)),
        turns,
        locationId,
      };
      sceneProposals.push({
        id: `${input.blockId}_${sceneId}`,
        kind: "create_scene",
        payload: scene,
        confidence: EXTRACTION_CONFIDENCE,
        provenance: { blockId: input.blockId, sentenceIds: spanIds, patchId: "extraction" },
      });
    }

    // --- stubs extraction never confirmed: drop, but leave a note ---
    for (const [candidate, stub] of stubByCandidate) {
      notes[stub.id] =
        `Name candidate "${candidate}" was judged new by Jev but extraction did not confirm it in this block; stub dropped rather than merged as a malformed entity.`;
    }

    // --- fold add_alias proposals into entity upserts (apply.ts) ---
    for (const ap of aliasProposals) {
      const payload = ap.payload as { entityId: string; aliasText: string };
      const entity = input.knownEntities.find((e) => e.id === payload.entityId);
      if (!entity) {
        notes[ap.id] = `Alias "${payload.aliasText}" targeted unknown entity ${payload.entityId}; dropped at extraction fold.`;
        continue;
      }
      if (entity.names.some((n) => n.text === payload.aliasText)) continue;
      const aliasForm: NameForm = {
        text: payload.aliasText,
        lang: entity.names[0]?.lang ?? "und",
        kind: "alias",
      };
      const existing = entityUpserts.get(entity.id);
      if (existing) {
        // Merge into the upsert already proposed for this entity
        // (e.g. forms folded in during extraction) rather than
        // replacing its payload and losing them.
        const current = existing.payload as Entity;
        if (!current.names.some((n) => n.text === payload.aliasText)) {
          current.names = [...current.names, aliasForm];
        }
      } else {
        entityUpserts.set(entity.id, {
          id: ap.id.replace(/_alias_/, "_aliasfold_"),
          kind: "upsert_entity",
          payload: { ...entity, names: [...entity.names, aliasForm] },
          confidence: ap.confidence,
          provenance: ap.provenance,
        });
      }
    }

    return {
      proposals: [
        ...otherProposals,
        ...entityUpserts.values(),
        ...sceneProposals,
        ...eventProposals,
        ...relationProposals,
        ...stateProposals,
      ],
      notes,
    };
  };
}
