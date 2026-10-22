import type { ChangeSet } from "../types";

export interface FeedEntry {
  id: number;
  text: string;
  tone: "plain" | "jev" | "warn" | "ok";
}

const TONE_COLOR: Record<FeedEntry["tone"], string> = {
  plain: "var(--dim)",
  jev: "var(--branch)",
  warn: "var(--amber)",
  ok: "var(--olive)",
};

export function DecisionFeed({ entries }: { entries: FeedEntry[] }) {
  return (
    <div className="panel">
      <h4>Decision stream</h4>
      <ul className="feed">
        {entries.map((e) => (
          <li key={e.id} style={{ color: TONE_COLOR[e.tone] }}>
            {e.text}
          </li>
        ))}
        {entries.length === 0 && <li className="dim">waiting for the session…</li>}
      </ul>
    </div>
  );
}

interface GateProps {
  changesets: ChangeSet[];
  heldMap: Record<string, string[]>;
  labels: Record<string, string>;
  onApprove: (changesetId: string) => void;
}

export function GateQueue({ changesets, heldMap, labels, onApprove }: GateProps) {
  return (
    <div className="panel">
      <h4>Gate queue</h4>
      {changesets.length === 0 && <p className="dim">No ChangeSets yet.</p>}
      {changesets.map((cs) => {
        const held = heldMap[cs.id] ?? [];
        const actionable = cs.nodeIds.filter((id) => !held.includes(id));
        return (
          <div key={cs.id} className="gate-card">
            <div className="gate-title">{cs.label}</div>
            <div className="gate-meta">
              <span className={`chip ${cs.status}`}>{cs.status}</span>
              <span>{cs.nodeIds.length} nodes</span>
              {held.length > 0 && (
                <span className="held-note">
                  ⧗ held: {held.map((id) => labels[id] ?? id).join(", ")} — awaiting revision
                </span>
              )}
            </div>
            {cs.status === "pending" && actionable.length > 0 && (
              <button className="approve" onClick={() => onApprove(cs.id)}>
                Approve {actionable.length} proposal{actionable.length === 1 ? "" : "s"}
              </button>
            )}
            {cs.status === "merged" && (
              <div className="ok-note">✓ merged into the graph</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface TabProps {
  count: number;
  shine: boolean;
  caughtUp: boolean;
  onClick: () => void;
}

/**
 * The activity tab: quiet while nothing matters, shining when the agent
 * is knitting somewhere the user is not looking. Click = guided flight.
 */
export function ActivityTab({ count, shine, caughtUp, onClick }: TabProps) {
  return (
    <button
      className={`activity-tab ${shine ? "shine" : ""} ${caughtUp ? "caught" : ""}`}
      onClick={onClick}
      title="Fly to where the agent is working"
    >
      {caughtUp ? "✓ Caught up" : "✦ Agent activity"}
      <span className="badge">{count}</span>
    </button>
  );
}
