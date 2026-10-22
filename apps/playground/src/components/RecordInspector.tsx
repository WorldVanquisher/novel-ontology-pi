import { KIND_LABEL, recordStatus } from "../archive";
import type { WorldEdge, WorldNode } from "../types";

interface Props {
  selected: WorldNode | undefined;
  nodes: WorldNode[];
  edges: WorldEdge[];
  childCount: number;
  canOpen: boolean;
  onSelect: (node: WorldNode) => void;
}

export function RecordInspector({ selected, nodes, edges, childCount, canOpen, onSelect }: Props) {
  if (!selected) return <p className="empty-state">No records in this view.</p>;
  const connections = edges.filter((edge) => edge.from === selected.id || edge.to === selected.id);
  return (
    <div className="record-inspector">
      <div className="record-eyebrow"><span>{KIND_LABEL[selected.kind]}</span><span>#{String(nodes.indexOf(selected) + 1).padStart(2, "0")}</span></div>
      <h2>{selected.label}</h2>
      <span className={`record-status status-${selected.state}`}><i />{recordStatus(selected)}</span>
      <div className="record-stamp" aria-hidden="true"><span>N / O</span><div className="barcode" /><span>ARCHIVE RECORD</span></div>
      <dl className="record-facts">
        <div><dt>Record ID</dt><dd>{selected.id}</dd></div>
        <div><dt>Timeline</dt><dd>{selected.lane === "canon" ? "01 / Canon" : "02 / Branch"}</dd></div>
        <div><dt>Sequence</dt><dd>{String(selected.chrono).padStart(2, "0")}</dd></div>
        <div><dt>Connections</dt><dd>{connections.length}</dd></div>
      </dl>
      {canOpen ? <p className="interior-summary">{childCount} interior records · click the file to enter ↗</p> : selected.kind === "bigEvent" && <p className="empty-state">No interior records in this sample.</p>}
      <div className="index-heading"><h3>Records in this view</h3><span>{nodes.length}</span></div>
      <ol className="record-index" aria-label="Archive records">
        {nodes.map((node, index) => (
          <li key={node.id}>
            <button className={node.id === selected.id ? "selected" : ""} aria-pressed={node.id === selected.id} onClick={() => onSelect(node)}>
              <span className="record-number">{String(index + 1).padStart(2, "0")}</span>
              <span><strong>{node.label}</strong><small>{KIND_LABEL[node.kind]} / {node.state !== "canon" ? node.state : node.lane}</small></span>
              <span aria-hidden="true">{node.id === selected.id ? "↗" : "·"}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
