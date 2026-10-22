# Pending repair and recall

`novel changeset revise <dir> <id> --edits '<JSON>' --reason '<reason>'`
preserves the predecessor, records an audit and leaves a fresh held packet.
Review the entire fresh revision before approval. Batch related verified
edits rather than spending one revision per defect.

Edit fields:
- `dropProposalIds`: remove unsupported proposals, including a wrong
  alias-fold upsert; do not drop a valid person's only identity for a typo.
- `removeEntityIds`: remove invalid newly proposed identities and dependent
  references; canonical entities require canonical maintenance instead.
- `sanitizeTypes: true`: remove invalid Character/Location slot references.
- `retypeEntities: [{"entityId":"...","kind":"Organization"}]`: correct a
  new entity's kind without changing its id/provenance. Requires
  `sanitizeTypes: true`. Other kinds: Character, Location, Item, Concept.
- `mentionedOnlyEntityIds`: downgrade presence/actor/speaker references
  throughout this block for people who are ONLY mentioned in the block.
  Do not use this globally for someone present in other scenes.

For an upstream cascade, pin a source-verified correction, then recall:

`novel fix correct <dir> --block <block-id> --key extraction:constraints --value '<JSON>' --reason '<reason>'`

`novel recall <dir> <block-id>`

Constraint fields: `distinctNames` (groups of DIFFERENT identities),
`rejectCharacterNames` (unsupported placeholders), `instructions`
(source-grounded extraction guidance). Same-person aliases must NOT go
into `distinctNames`. Recall preserves the old packet and honors the pin.
Never recall an applied block without a canonical rollback plan. Respect
the supplied limits; do not re-ingest a held block to evade them.
