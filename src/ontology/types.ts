/**
 * Ontology types — English-canonical, language-neutral identity.
 *
 * Every type name, relation name, property key and enum value in storage is
 * English, so a novel in any language maps onto the same paradigm.
 * Identity is an opaque ID; every name is data on the entity.
 */

export type EntityKind =
  | "Character"
  | "Location"
  | "Organization"
  | "Item"
  | "Concept"
  | "Event"
  | "Scene"
  | "Timeline"
  | "Branch";

export interface NameForm {
  text: string;
  /** BCP-47 tag of the surface form, e.g. "zh", "ja", "en". */
  lang: string;
  kind: "canonical" | "alias" | "nickname" | "title";
}

export interface Entity {
  /** Opaque, language-neutral ID, e.g. "char_000123". */
  id: string;
  kind: EntityKind;
  names: NameForm[];
  /** Free-form English-keyed properties, constrained per kind by schema v1. */
  properties: Record<string, unknown>;
  confidence: number;
}

export type RelationType =
  | "CAUSES"
  | "CAUSED_BY"
  | "PARTICIPATES_IN"
  | "PRESENT_IN"
  | "MENTIONED_IN"
  | "LOCATED_AT"
  | "KNOWS"
  | "SPEAKS_TO"
  | "ADDRESSES"
  | "OWNS"
  | "MEMBER_OF"
  | "STATE_BEFORE"
  | "STATE_AFTER"
  | "FORKS_FROM"
  | "PRECEDES";

export interface Relation {
  fromId: string;
  toId: string;
  type: RelationType;
  properties: Record<string, unknown>;
  confidence: number;
}

export type EventType =
  | "dialogue"
  | "action"
  | "revelation"
  | "conflict"
  | "movement"
  | "decision"
  | "introduction"
  | "resolution"
  | "other";

export interface OntEvent {
  id: string;
  timelineId: string;
  chapterIndex: number;
  /** Global order within the timeline; any value here is a valid fork point. */
  chronologicalOrder: number;
  eventType: EventType;
  /** Source-language summary; legacy field name retained for storage compatibility. */
  summaryEn: string;
  /** Original-language evidence quote, with provenance offsets. */
  evidence: { text: string; sentenceIds: string[] };
  importance: number; // 0..1
  primaryActors: string[]; // entity IDs
  affectedCharacters: string[]; // entity IDs
  confidence: number;
}

export interface DialogueTurn {
  speakerId: string | null; // null = unresolved / unknown
  addresseeId: string | null;
  sentenceIds: string[];
}

export interface Scene {
  id: string;
  chapterIndex: number;
  sentenceIds: string[];
  charactersPresent: string[]; // entity IDs — decided by the presence patch
  charactersMentioned: string[]; // mentioned is NOT present
  turns: DialogueTurn[];
  locationId: string | null;
}

export interface Branch {
  id: string;
  parentTimelineId: string;
  /** The canon event this branch forks from — chosen by the user. */
  forkEventId: string;
  label: string;
}

/** Character state at a point = fold of the event stream up to that point. */
export interface CharacterStateAtPoint {
  characterId: string;
  atEventId: string;
  emotions: Record<string, number>;
  knowledge: string[];
  goals: string[];
  relationships: Record<string, number>;
}
