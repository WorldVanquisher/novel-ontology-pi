import type { DecisionPatch } from "./types.js";
import { dialogueDetector } from "./dialogue-detector.js";
import { nameDetector } from "./name-detector.js";
import { sceneBoundary } from "./scene-boundary.js";
import { speakerAttribution } from "./speaker-attribution.js";
import { presenceDetector } from "./presence-detector.js";

/**
 * v1 patch registry — ORDER MATTERS.
 * Sectioning output flows: scene spans → dialogue units → names/presence
 * → speaker attribution. Later patches consume earlier patches' accepted
 * decisions via PatchContext.accepted.
 *
 * The full catalog (state changes, event-worthiness, causal candidates,
 * foreshadowing, ...) lives in docs/system1.html as an open discussion
 * list — each new functionality is one new patch added here.
 */
export const PATCH_REGISTRY: DecisionPatch[] = [
  sceneBoundary,
  dialogueDetector,
  nameDetector,
  presenceDetector,
  speakerAttribution,
];
