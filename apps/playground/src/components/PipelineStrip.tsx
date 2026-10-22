import { Background, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

const STAGES = [
  { id: "sectioning", label: "Sectioning" },
  { id: "miniloop", label: "Miniloop · Jev" },
  { id: "extraction", label: "Extraction" },
  { id: "changeset", label: "ChangeSet" },
  { id: "gate", label: "Merge gate" },
];

/** The pipeline strip (React Flow) — which stage is working, at a glance. */
export function PipelineStrip({ stage }: { stage: number }) {
  const nodes: Node[] = STAGES.map((s, i) => ({
    id: s.id,
    position: { x: i * 150, y: 12 },
    data: { label: s.label },
    draggable: false,
    style: {
      width: 128,
      borderRadius: 9,
      fontSize: 12,
      color: i < stage ? "#34d399" : i === stage ? "#2dd4bf" : "#8b96ab",
      background: "#121828",
      border: `1px solid ${i < stage ? "#34d399" : i === stage ? "#2dd4bf" : "#26304a"}`,
      boxShadow: i === stage ? "0 0 12px rgba(45,212,191,.35)" : "none",
    },
  }));
  const edges: Edge[] = STAGES.slice(1).map((s, i) => ({
    id: `pe_${i}`,
    source: STAGES[i].id,
    target: s.id,
    animated: stage === i + 1,
    style: { stroke: "#3b4a6b" },
  }));
  return (
    <div style={{ height: 74, background: "#0d1220" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1b2438" gap={18} />
      </ReactFlow>
    </div>
  );
}
