export const EXTRACTION_CONSTRAINTS_KEY = "extraction:constraints";

export interface ExtractionConstraints {
  distinctNames?: string[][];
  rejectCharacterNames?: string[];
  instructions?: string;
}

export function parseExtractionConstraints(value: unknown): ExtractionConstraints {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Extraction constraints must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["distinctNames", "rejectCharacterNames", "instructions"].includes(key))) {
    throw new Error("Unknown extraction constraint key.");
  }
  const names = (entry: unknown): entry is string[] => Array.isArray(entry)
    && entry.every((name) => typeof name === "string" && name.trim().length > 0);
  if (record.distinctNames !== undefined && (!Array.isArray(record.distinctNames)
    || !record.distinctNames.every((group) => names(group) && new Set(group).size >= 2))) {
    throw new Error("distinctNames must contain groups of at least two distinct nonempty name forms.");
  }
  if (record.rejectCharacterNames !== undefined && !names(record.rejectCharacterNames)) {
    throw new Error("rejectCharacterNames must be an array of nonempty name forms.");
  }
  if (record.instructions !== undefined && (typeof record.instructions !== "string" || !record.instructions.trim())) {
    throw new Error("instructions must be nonempty text.");
  }
  return record as ExtractionConstraints;
}
