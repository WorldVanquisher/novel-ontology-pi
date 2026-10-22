import { Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const STAGES = ["Sectioning", "Miniloop / Jev", "Extraction", "ChangeSet", "Merge gate"];
const STATUS_LABEL = { idle: "Waiting for agent", working: "Agent working", review: "Awaiting review", complete: "Merged · held records stay separate", error: "Replay unavailable" };

interface Props {
  stage: number;
  status: keyof typeof STATUS_LABEL;
  reducedMotion: boolean;
}

export function PipelineStrip({ stage, status, reducedMotion }: Props) {
  const nodes: Node[] = STAGES.map((label, index) => ({
    id: String(index),
    position: { x: index * 166, y: 0 },
    data: { label: `${String(index + 1).padStart(2, "0")} / ${label}` },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    className: `${index < stage || status === "complete" ? "complete" : index === stage ? "current" : ""}${index === stage && status === "working" ? " working" : ""}`,
    ariaLabel: `${label}: ${index < stage || status === "complete" ? "complete" : index === stage ? STATUS_LABEL[status] : "waiting"}`,
    style: { width: 138, height: 32 },
  }));
  const edges: Edge[] = STAGES.slice(1).map((_, index) => ({
    id: `pipeline-${index}`,
    source: String(index),
    target: String(index + 1),
    type: "straight",
    animated: !reducedMotion && status === "working" && stage === index + 1,
    style: { stroke: index < stage ? "var(--olive)" : "var(--faint)", strokeWidth: 1.5 },
  }));
  return (
    <section className="pipeline" aria-label="Live agent processing pipeline">
      <div className="pipeline-summary"><span className="eyebrow">Processing / 01—05</span><span role="status">{STATUS_LABEL[status]}{status === "working" ? ` · ${STAGES[stage]}` : ""}</span></div>
      <div className="pipeline-viewport"><div className="pipeline-flow">
        <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.08 }} minZoom={0.4} maxZoom={1}
          nodesDraggable={false} nodesConnectable={false} elementsSelectable={false} edgesFocusable={false}
          panOnDrag={false} panOnScroll={false} zoomOnScroll={false} zoomOnPinch={false} zoomOnDoubleClick={false}
          preventScrolling={false} colorMode="dark" proOptions={{ hideAttribution: true }}>
        </ReactFlow>
      </div></div>
    </section>
  );
}
