import { forwardRef, useEffect, useRef } from "react";
import {
  GraphCanvas,
  darkTheme,
  type GraphCanvasRef,
  type GraphEdge as RGEdge,
  type GraphNode as RGNode,
} from "reagraph";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import type { WorldEdge, WorldNode } from "../types";

const KIND_FILL: Record<WorldNode["kind"], string> = {
  bigEvent: "#2dd4bf",
  character: "#a78bfa",
  location: "#7dd3fc",
  scene: "#94a3b8",
  event: "#2dd4bf",
  dialogue: "#fbbf24",
};

/**
 * Reagraph's camera lives at distance ~1000+ by default, so authored
 * coordinates (hundreds) are scaled up into its working range.
 */
export const SCALE = 4;

/** Deterministic front-side framing for a set of scaled positions. */
export function framePositions(
  ref: { current: GraphCanvasRef | null },
  positions: [number, number, number][],
  pad = 1.3,
  animated = true,
): void {
  if (positions.length === 0) return;
  const controls = ref.current?.getControls?.() as
    | {
        camera: { fov: number };
        setTarget: (x: number, y: number, z: number, t?: boolean) => unknown;
        setPosition: (x: number, y: number, z: number, t?: boolean) => unknown;
      }
    | undefined;
  if (!controls) return;
  const center: [number, number, number] = [0, 0, 0];
  for (const p of positions) {
    center[0] += p[0] / positions.length;
    center[1] += p[1] / positions.length;
    center[2] += p[2] / positions.length;
  }
  let radius = 300;
  for (const p of positions) {
    const d = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    if (d > radius) radius = d;
  }
  const fov = ((controls.camera.fov || 10) * Math.PI) / 180;
  const dist = Math.max(1400, (radius / Math.tan(fov / 2)) * pad);
  void controls.setTarget(center[0], center[1], center[2], animated);
  void controls.setPosition(
    center[0],
    center[1] + dist * 0.16,
    center[2] + dist,
    animated,
  );
}

export function scaledPos(
  n: WorldNode,
  interior: boolean,
): [number, number, number] {
  const p = interior ? n.interiorPos : n.lanePos;
  return [p[0] * SCALE, p[1] * SCALE, p[2] * SCALE];
}

/** Shared channel between the app (which owns the label DOM) and the projector. */
export interface LabelBus {
  targets: Map<string, HTMLElement>;
  active: Set<string>;
}

function toRGNode(
  n: WorldNode,
  pos: [number, number, number],
  pinned: boolean,
): RGNode {
  let fill = KIND_FILL[n.kind];
  if (n.lane === "branch" && n.kind === "bigEvent") fill = "#a78bfa";
  if (n.state === "proposed") fill = "#d97706"; // amber ghost
  if (n.state === "held") fill = "#64748b"; // slate — held reads differently from pending
  return {
    id: n.id,
    label: n.label,
    fill,
    size: n.kind === "bigEvent" ? 56 : n.kind === "character" ? 38 : 30,
    data: { world: n },
    // Reagraph v4.32 fixed positions are fx/fy/fz (a `position` field is ignored).
    ...(pinned
      ? { fx: pos[0] * SCALE, fy: pos[1] * SCALE, fz: pos[2] * SCALE }
      : {}),
  } as RGNode;
}

function toRGEdge(e: WorldEdge): RGEdge {
  const color =
    e.state === "proposed"
      ? "#d97706"
      : e.state === "held"
        ? "#64748b"
        : e.kind === "flow"
          ? "#2dd4bf"
          : e.kind === "cross"
            ? "#a78bfa"
            : "#475569";
  return {
    id: e.id,
    source: e.from,
    target: e.to,
    fill: color,
    size: e.kind === "flow" ? 3 : 1.5,
  } as RGEdge;
}

/**
 * Projects live node positions to screen space every frame and moves
 * the app's HTML label elements to match. Positions are read from the
 * three.js scene itself: Reagraph's node groups carry
 * `userData: { id, type: "node" }`, so this works in both the pinned
 * (chronological) layout and the force layout. Labels are plain DOM —
 * Reagraph's built-in labels (troika/drei Text) fetch font data from a
 * CDN at runtime, which this local-first app must not depend on.
 */
function LabelProjector({ bus }: { bus: LabelBus }) {
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const scene = useThree((s) => s.scene);
  useFrame(() => {
    const v = new Vector3();
    scene.traverse((obj) => {
      const ud = obj.userData as { id?: string; type?: string };
      if (ud?.type !== "node" || !ud.id) return;
      const el = bus.targets.get(ud.id);
      if (!el) return;
      if (!bus.active.has(ud.id)) {
        el.style.display = "none";
        return;
      }
      obj.getWorldPosition(v).project(camera);
      if (v.z > 1 || v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.05) {
        el.style.display = "none";
        return;
      }
      el.style.display = "";
      el.style.transform = `translate(-50%, -150%) translate(${(v.x * 0.5 + 0.5) * size.width}px, ${(-v.y * 0.5 + 0.5) * size.height}px)`;
    });
  });
  return null;
}

interface Props {
  nodes: WorldNode[];
  edges: WorldEdge[];
  interior: boolean;
  layout: "locked" | "force";
  labelBus: LabelBus;
  onNodeClick: (node: WorldNode) => void;
}

/**
 * The one-world graph stage (Reagraph, dark theme). Positions are
 * authored from the ontology (chronological layout), so the default
 * layout is "locked" — every node pinned at its fx/fy/fz; "force"
 * unpins and lets the simulation settle organically. The camera
 * auto-frames whenever the visible graph changes.
 */
export const WorldGraph = forwardRef<GraphCanvasRef, Props>(function WorldGraph(
  { nodes, edges, interior, layout, labelBus, onNodeClick },
  ref,
) {
  const ids = new Set(nodes.map((n) => n.id));
  const rgNodes = nodes.map((n) =>
    toRGNode(n, interior ? n.interiorPos : n.lanePos, layout === "locked"),
  );
  const rgEdges = edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map(toRGEdge);

  // Frame ONLY when the view or layout changes — never when data grows.
  // Agent activity must not steal the camera (unified-world principle);
  // the activity tab's guided flight is the explicit way to travel.
  const viewKey = `${interior ? "in" : "lanes"}|${layout}`;
  const positionsRef = useRef<[number, number, number][]>([]);
  positionsRef.current = nodes.map((n) => scaledPos(n, interior));
  useEffect(() => {
    const apply = () =>
      framePositions(
        ref as { current: GraphCanvasRef | null },
        positionsRef.current,
      );
    const t1 = setTimeout(apply, 300);
    const t2 = setTimeout(apply, 1600); // settle after Reagraph's mount fit
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);

  return (
    <GraphCanvas
      ref={ref}
      nodes={rgNodes}
      edges={rgEdges}
      theme={darkTheme}
      glOptions={{ preserveDrawingBuffer: true }}
      layoutType="forceDirected3d"
      cameraMode="rotate"
      draggable={false}
      labelType="none"
      edgeArrowPosition="end"
      animated={layout === "force"}
      onNodeClick={(node) => {
        const world = (node as RGNode).data?.world as WorldNode | undefined;
        if (world) onNodeClick(world);
      }}
    >
      <LabelProjector bus={labelBus} />
    </GraphCanvas>
  );
});
