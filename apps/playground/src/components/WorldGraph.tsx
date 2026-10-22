import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { GraphCanvas, darkTheme, type GraphCanvasRef, type GraphNode, type GraphEdge } from "reagraph";
import { useFrame, useThree } from "@react-three/fiber";
import { Vector3 } from "three";
import { ArchiveNode } from "./ArchiveNode";
import { recordColor } from "../archive";
import type { WorldEdge, WorldNode } from "../types";
import type { TimelineTrack } from "../data/timelineLayout";

export const SCALE = 3;

const archiveTheme = {
  ...darkTheme,
  canvas: { background: "#171d1b", fog: null },
  node: { ...darkTheme.node, opacity: 1, selectedOpacity: 1, inactiveOpacity: 1 },
  edge: { ...darkTheme.edge, fill: "#8a947c", activeFill: "#acbc8e", opacity: 0.55, selectedOpacity: 0.8, inactiveOpacity: 0.2 },
  arrow: { fill: "#8a947c", activeFill: "#acbc8e" },
};

export function framePositions(
  ref: { current: GraphCanvasRef | null },
  positions: [number, number, number][],
  pad = 1.18,
  animated = true,
): void {
  if (!positions.length) return;
  const controls = ref.current?.getControls?.() as {
    camera: { fov: number; aspect: number };
    setTarget: (horizontal: number, vertical: number, depth: number, transition?: boolean) => unknown;
    setPosition: (horizontal: number, vertical: number, depth: number, transition?: boolean) => unknown;
  } | undefined;
  if (!controls) return;
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const position of positions) {
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], position[axis]);
      maximum[axis] = Math.max(maximum[axis], position[axis]);
    }
  }
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const halfWidth = (maximum[0] - minimum[0]) / 2 + 190;
  const halfHeight = (maximum[1] - minimum[1]) / 2 + 230;
  const tangent = Math.tan((controls.camera.fov || 10) * Math.PI / 360);
  const stage = document.querySelector<HTMLElement>(".stage");
  const height = stage?.clientHeight || window.innerHeight;
  const width = stage?.clientWidth || window.innerWidth;
  const usableHeight = Math.max(0.4, (height - 300) / height);
  const usableWidth = Math.max(0.5, (width - 90) / width);
  const distance = Math.max(halfHeight / (tangent * usableHeight), halfWidth / (tangent * (controls.camera.aspect || 1) * usableWidth)) * pad;
  void controls.setTarget(center[0], center[1], center[2], animated);
  void controls.setPosition(center[0] + distance * 0.035, center[1] + distance * 0.14, center[2] + distance, animated);
}

export function scaledPos(node: WorldNode, interior: boolean): [number, number, number] {
  const position = interior ? node.interiorPos : node.lanePos;
  return [position[0] * SCALE, position[1] * SCALE, position[2] * SCALE];
}

export interface LabelBus {
  targets: Map<string, HTMLElement>;
  active: Set<string>;
  positions: Map<string, [number, number, number]>;
  trackTargets: Map<string, HTMLElement>;
}

function toGraphNode(node: WorldNode, interior: boolean, pinned: boolean): GraphNode {
  const position = scaledPos(node, interior);
  return {
    id: node.id, label: node.label, fill: recordColor(node),
    size: node.kind === "bigEvent" ? 70 : node.kind === "character" ? 38 : 32,
    data: { world: node },
    ...(pinned ? { fx: position[0], fy: position[1], fz: position[2] } : {}),
  };
}

function toGraphEdge(edge: WorldEdge): GraphEdge {
  return {
    id: edge.id, source: edge.from, target: edge.to,
    fill: edge.state === "proposed" ? "#c6a16b" : edge.state === "held" ? "#819398" : edge.kind === "cross" ? "#b49a8b" : "#8a947c",
    size: edge.kind === "flow" ? 2 : 1,
    dashed: edge.state !== "canon" || edge.kind === "cross",
  };
}

function LabelProjector({ bus, selectedId, hoveredId, nodes, tracks, interior }: {
  bus: LabelBus; selectedId: string | null; hoveredId: string | null; nodes: WorldNode[]; tracks: TimelineTrack[]; interior: boolean;
}) {
  const { camera, size, scene } = useThree();
  const point = useRef(new Vector3());
  const records = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  useFrame(() => {
    bus.positions.clear();
    const candidates: { element: HTMLElement; horizontal: number; vertical: number; priority: number }[] = [];
    scene.traverse((object) => {
      const data = object.userData as { id?: string; type?: string };
      if (data.type !== "node" || !data.id) return;
      const element = bus.targets.get(data.id);
      if (!element) return;
      element.style.visibility = "hidden";
      const node = records.get(data.id);
      if (!node || !bus.active.has(node.id)) return;
      object.getWorldPosition(point.current);
      bus.positions.set(node.id, [point.current.x, point.current.y, point.current.z]);
      const focused = node.id === selectedId || node.id === hoveredId;
      if (!focused && node.kind !== "bigEvent" && node.kind !== "location" && node.kind !== "event" && node.kind !== "character") return;
      if (node.kind === "character") { point.current.x += 125; point.current.y -= 10; }
      else if (node.kind !== "bigEvent") point.current.y -= 110;
      point.current.project(camera);
      if (point.current.z > 1 || Math.abs(point.current.x) > 1 || Math.abs(point.current.y) > 1) return;
      candidates.push({ element, horizontal: (point.current.x * 0.5 + 0.5) * size.width, vertical: (-point.current.y * 0.5 + 0.5) * size.height, priority: node.id === selectedId ? 0 : node.id === hoveredId ? 1 : node.kind === "bigEvent" ? 2 : 3 });
    });
    const occupied: { left: number; top: number; right: number; bottom: number }[] = [];
    candidates.sort((first, second) => first.priority - second.priority);
    for (const candidate of candidates) {
      const width = candidate.element.offsetWidth;
      const height = candidate.element.offsetHeight;
      const rectangle = { left: candidate.horizontal - width / 2 - 5, top: candidate.vertical - height / 2 - 5, right: candidate.horizontal + width / 2 + 5, bottom: candidate.vertical + height / 2 + 5 };
      if (candidate.priority > 0 && occupied.some((other) => rectangle.left < other.right && rectangle.right > other.left && rectangle.top < other.bottom && rectangle.bottom > other.top)) continue;
      candidate.element.style.visibility = "visible";
      candidate.element.style.transform = `translate(${candidate.horizontal}px, ${candidate.vertical}px) translate(-50%, -50%)`;
      occupied.push(rectangle);
    }
    for (const track of tracks) {
      const element = bus.trackTargets.get(track.id);
      if (!element) continue;
      point.current.set((track.start[0] + 70) * SCALE, track.start[1] * SCALE + (interior ? 140 : 245), track.start[2] * SCALE).project(camera);
      const visible = point.current.z < 1 && Math.abs(point.current.x) < 1 && Math.abs(point.current.y) < 1;
      element.style.visibility = visible ? "visible" : "hidden";
      element.style.transform = `translate(${(point.current.x * 0.5 + 0.5) * size.width}px, ${(-point.current.y * 0.5 + 0.5) * size.height}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

function TimelineRails({ tracks }: { tracks: TimelineTrack[] }) {
  return <>{tracks.map((track) => {
    const length = (track.end[0] - track.start[0]) * SCALE;
    const color = track.lane === "branch" ? "#9e877a" : "#81946d";
    return <group key={track.id} position={[track.start[0] * SCALE, track.start[1] * SCALE, -65]}>
      <mesh position={[length / 2, 0, 0]}><boxGeometry args={[length, 2.2, 2.2]} /><meshBasicMaterial color={color} /></mesh>
      <mesh position={[length + 8, 0, 0]} rotation={[0, 0, -Math.PI / 2]}><coneGeometry args={[9, 24, 3]} /><meshBasicMaterial color={color} /></mesh>
    </group>;
  })}</>;
}

function SemanticZoom({ nodes, openableIds, onOpen, interior, onExit }: { nodes: WorldNode[]; openableIds: string[]; onOpen: (node: WorldNode) => void; interior: boolean; onExit: () => void }) {
  const { camera, scene, gl, size } = useThree();
  const intent = useRef({ at: -Infinity, horizontal: 0, vertical: 0, direction: "in" as "in" | "out" });
  const fired = useRef(false);
  const available = useMemo(() => new Map(nodes.filter((node) => openableIds.includes(node.id)).map((node) => [node.id, node])), [nodes, openableIds]);
  useEffect(() => {
    const surface = gl.domElement.closest(".stage") ?? gl.domElement;
    const recordIntent = (horizontal: number, vertical: number, direction: "in" | "out") => {
      const rectangle = gl.domElement.getBoundingClientRect();
      intent.current = { at: performance.now(), horizontal: ((horizontal - rectangle.left) / rectangle.width) * 2 - 1, vertical: 1 - ((vertical - rectangle.top) / rectangle.height) * 2, direction };
    };
    const wheel = (event: Event) => {
      const input = event as WheelEvent;
      if (input.deltaY) recordIntent(input.clientX, input.clientY, input.deltaY < 0 ? "in" : "out");
    };
    let pinchDistance = 0;
    const resetPinch = () => { pinchDistance = 0; };
    const touch = (event: Event) => {
      const input = event as TouchEvent;
      if (input.touches.length !== 2) { pinchDistance = 0; return; }
      const [first, second] = input.touches;
      const distance = Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
      if (pinchDistance && distance !== pinchDistance) recordIntent((first.clientX + second.clientX) / 2, (first.clientY + second.clientY) / 2, distance > pinchDistance ? "in" : "out");
      pinchDistance = distance;
    };
    surface.addEventListener("wheel", wheel, { passive: true });
    surface.addEventListener("touchstart", resetPinch, { passive: true });
    surface.addEventListener("touchmove", touch, { passive: true });
    surface.addEventListener("touchend", resetPinch, { passive: true });
    surface.addEventListener("touchcancel", resetPinch, { passive: true });
    return () => {
      surface.removeEventListener("wheel", wheel);
      surface.removeEventListener("touchstart", resetPinch);
      surface.removeEventListener("touchmove", touch);
      surface.removeEventListener("touchend", resetPinch);
      surface.removeEventListener("touchcancel", resetPinch);
    };
  }, [gl]);
  useFrame(() => {
    if (fired.current || performance.now() - intent.current.at > 1500) return;
    const usableHeight = Math.max(0.4, (size.height - 300) / size.height);
    const usableWidth = Math.max(0.5, (size.width - 90) / size.width);
    if (interior) {
      if (intent.current.direction !== "out") return;
      const points: Vector3[] = [];
      scene.traverse((object) => {
        if (object.userData.type !== "node") return;
        const position = object.getWorldPosition(new Vector3());
        points.push(position.clone().add(new Vector3(-90, -90, 0)).project(camera), position.clone().add(new Vector3(90, 90, 0)).project(camera));
      });
      if (!points.length) return;
      const horizontal = (Math.max(...points.map((point) => point.x)) - Math.min(...points.map((point) => point.x))) / (2 * usableWidth);
      const vertical = (Math.max(...points.map((point) => point.y)) - Math.min(...points.map((point) => point.y))) / (2 * usableHeight);
      if (Math.max(horizontal, vertical) < 0.26) { fired.current = true; onExit(); }
      return;
    }
    if (intent.current.direction !== "in") return;
    const candidates: { node: WorldNode; distance: number }[] = [];
    scene.traverse((object) => {
      if (object.userData.type !== "node") return;
      const node = available.get(object.userData.id);
      if (!node) return;
      const position = object.getWorldPosition(new Vector3());
      const center = position.clone().project(camera);
      if (center.z > 1 || Math.abs(center.x) > 1.2 || Math.abs(center.y) > 1.2) return;
      const top = position.clone().add(new Vector3(0, 180, 0)).project(camera);
      const bottom = position.clone().add(new Vector3(0, -180, 0)).project(camera);
      const left = position.clone().add(new Vector3(-170, 0, 0)).project(camera);
      const right = position.clone().add(new Vector3(170, 0, 0)).project(camera);
      const halfHeight = Math.abs(top.y - bottom.y) / 2;
      const halfWidth = Math.abs(right.x - left.x) / 2;
      if (halfHeight < 0.68 * usableHeight || Math.abs(center.x - intent.current.horizontal) > halfWidth + 0.12 || Math.abs(center.y - intent.current.vertical) > halfHeight + 0.12) return;
      candidates.push({ node, distance: Math.hypot(center.x - intent.current.horizontal, center.y - intent.current.vertical) });
    });
    const next = candidates.sort((first, second) => first.distance - second.distance)[0];
    if (next) { fired.current = true; onOpen(next.node); }
  });
  return null;
}

function Framing({ graphRef, positions, viewKey, reducedMotion }: {
  graphRef: { current: GraphCanvasRef | null }; positions: { current: [number, number, number][] }; viewKey: string; reducedMotion: boolean;
}) {
  const { width, height } = useThree((state) => state.size);
  const scene = useThree((state) => state.scene);
  const surface = useThree((state) => state.gl.domElement);
  useEffect(() => {
    let interacted = false;
    const markInteraction = () => { interacted = true; };
    surface.addEventListener("wheel", markInteraction, { passive: true });
    surface.addEventListener("pointerdown", markInteraction, { passive: true });
    const apply = () => { if (!interacted) framePositions(graphRef, positions.current, 1.18, !reducedMotion); };
    const settle = () => {
      if (interacted) return;
      const actual: [number, number, number][] = [];
      scene.traverse((object) => {
        if (object.userData.type !== "node") return;
        const position = object.getWorldPosition(new Vector3());
        actual.push([position.x, position.y, position.z]);
      });
      framePositions(graphRef, actual.length ? actual : positions.current, 1.18, !reducedMotion);
    };
    const initial = setTimeout(apply, 100);
    const settled = setTimeout(settle, 900);
    return () => {
      clearTimeout(initial); clearTimeout(settled);
      surface.removeEventListener("wheel", markInteraction);
      surface.removeEventListener("pointerdown", markInteraction);
    };
  }, [graphRef, positions, viewKey, width, height, reducedMotion, scene, surface]);
  return null;
}

interface Props {
  nodes: WorldNode[]; edges: WorldEdge[]; interior: boolean; viewId: string;
  tracks: TimelineTrack[]; openableIds: string[];
  labelBus: LabelBus; selectedId: string | null; reducedMotion: boolean;
  onNodeClick: (node: WorldNode) => void; onNodeOpen: (node: WorldNode) => void;
  onViewBack: () => void;
}

export const WorldGraph = forwardRef<GraphCanvasRef, Props>(function WorldGraph(
  { nodes, edges, tracks, interior, viewId, openableIds, labelBus, selectedId, reducedMotion, onNodeClick, onNodeOpen, onViewBack }, ref,
) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const positions = useRef<[number, number, number][]>([]);
  positions.current = nodes.map((node) => scaledPos(node, interior));
  const graphNodes = useMemo(() => nodes.map((node) => toGraphNode(node, interior, true)), [nodes, interior]);
  const graphEdges = useMemo(() => {
    const ids = new Set(nodes.map((node) => node.id));
    return edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map(toGraphEdge);
  }, [nodes, edges]);
  const selections = useMemo(() => selectedId ? [selectedId] : [], [selectedId]);
  return (
    <GraphCanvas
      ref={ref}
      nodes={graphNodes}
      edges={graphEdges}
      theme={archiveTheme}
      renderNode={ArchiveNode}
      selections={selections}
      glOptions={{ preserveDrawingBuffer: true, antialias: true }}
      layoutType="forceDirected3d" cameraMode="rotate" draggable={false} labelType="none"
      edgeArrowPosition="end" animated={false}
      onNodeClick={(node) => onNodeClick(node.data.world as WorldNode)}
      onNodePointerOver={(node) => setHoveredId(node.id)}
      onNodePointerOut={() => setHoveredId(null)}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[-900, 1800, 2200]} intensity={1.6} color="#fff9e9" />
      <directionalLight position={[1400, -600, 500]} intensity={0.5} color="#cdd4c4" />
      <TimelineRails tracks={tracks} />
      <Framing graphRef={ref as { current: GraphCanvasRef | null }} positions={positions} viewKey={viewId} reducedMotion={reducedMotion} />
      <LabelProjector bus={labelBus} selectedId={selectedId} hoveredId={hoveredId} nodes={nodes} tracks={tracks} interior={interior} />
      <SemanticZoom key={viewId} nodes={nodes} openableIds={openableIds} onOpen={onNodeOpen} interior={interior} onExit={onViewBack} />
    </GraphCanvas>
  );
});
