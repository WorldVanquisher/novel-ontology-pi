import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GraphCanvasRef } from "reagraph";
import { ActivityTab, DecisionFeed, GateQueue, type FeedEntry } from "./components/panels";
import { PipelineStrip } from "./components/PipelineStrip";
import { WorldGraph, framePositions, scaledPos, type LabelBus } from "./components/WorldGraph";
import { loadWorld, type LoadedWorld } from "./data/loadWorld";
import { FileEventSource } from "./events/fileSource";
import { RecordInspector } from "./components/RecordInspector";
import { KIND_LABEL } from "./archive";
import { arrangeTimeline } from "./data/timelineLayout";
import type {
  ChangeSet,
  PlaygroundEvent,
  ViewState,
  WorldEdge,
  WorldNode,
} from "./types";

const KNIT_SITE = "be_found"; // the branch big event System 1 knits in this session
const DB = "/db/novel";
let feedSeq = 0;

export default function App() {
  const [world, setWorld] = useState<LoadedWorld | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>({ mode: "lanes" });
  const [showRelations, setShowRelations] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>("be_return");
  const [panel, setPanel] = useState<"record" | "activity" | "review">("record");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [dynNodes, setDynNodes] = useState<WorldNode[]>([]);
  const [dynEdges, setDynEdges] = useState<WorldEdge[]>([]);
  const [proposalsByCs, setProposalsByCs] = useState<Record<string, string[]>>({});
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [stage, setStage] = useState(0);
  const [changesets, setChangesets] = useState<ChangeSet[]>([]);
  const [heldMap, setHeldMap] = useState<Record<string, string[]>>({});
  const [activity, setActivity] = useState({ count: 0, shine: false, caughtUp: false });
  const [blockLabel, setBlockLabel] = useState<string | null>(null);
  const sourceRef = useRef<FileEventSource | null>(null);
  const graphRef = useRef<GraphCanvasRef>(null);
  const inspectorRef = useRef<HTMLDivElement>(null);
  const labelBus = useMemo<LabelBus>(
    () => ({ targets: new Map(), active: new Set(), positions: new Map(), trackTargets: new Map() }),
    [],
  );
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    loadWorld(`${DB}/view.json`)
      .then(setWorld)
      .catch((e: Error) => setLoadError(e.message));
  }, []);

  const pushFeed = useCallback((text: string, tone: FeedEntry["tone"] = "plain") => {
    setFeed((f) => [...f.slice(-40), { id: ++feedSeq, text, tone }]);
  }, []);

  /** Activity shines when something happens where the user is NOT looking. */
  const noteActivity = useCallback((alwaysShine: boolean) => {
    const v = viewRef.current;
    const atSite = v.mode === "interior" && v.bigEventId === KNIT_SITE;
    if (atSite && !alwaysShine) return;
    setActivity((a) => ({ count: a.count + 1, shine: true, caughtUp: false }));
  }, []);

  const handleEvent = useCallback(
    (ev: PlaygroundEvent) => {
      switch (ev.type) {
        case "block.started":
          setBlockLabel(ev.label);
          setStage(0);
          pushFeed(`▸ ${ev.label} entered the pipeline`);
          break;
        case "sectioned":
          setStage(1);
          pushFeed(`▸ sectioned — ${ev.sentences} sentences`);
          break;
        case "verdict":
          pushFeed(ev.text, "jev");
          break;
        case "proposal.added":
          setDynNodes((ns) => [...ns, ev.node]);
          setDynEdges((es) => [...es, ...ev.edges]);
          setProposalsByCs((m) => ({
            ...m,
            [ev.changesetId]: [...(m[ev.changesetId] ?? []), ev.node.id],
          }));
          pushFeed(`◌ proposal — ${ev.node.label} (ghost, branch)`, "warn");
          noteActivity(false);
          break;
        case "changeset.pending":
          setStage(4);
          setChangesets((cs) => [
            ...cs,
            { id: ev.changesetId, label: ev.label, status: "pending", nodeIds: ev.nodeIds },
          ]);
          pushFeed(`⚖ ${ev.label} reached the GATE`, "warn");
          noteActivity(true); // gate arrivals always shine
          break;
        case "changeset.held": {
          setHeldMap((m) => ({ ...m, [ev.changesetId]: ev.nodeIds }));
          setDynNodes((ns) =>
            ns.map((n) => (ev.nodeIds.includes(n.id) ? { ...n, state: "held" } : n)),
          );
          setDynEdges((es) =>
            es.map((e) =>
              ev.nodeIds.includes(e.from) || ev.nodeIds.includes(e.to)
                ? { ...e, state: "held" }
                : e,
            ),
          );
          pushFeed("⧗ main agent HELD 1 proposal — 事件·提前归还 (uncertain)", "warn");
          noteActivity(true); // escalations shine immediately
          break;
        }
        case "changeset.merged":
          pushFeed(`✓ ${ev.changesetId} merged — graph rebuilt`, "ok");
          break;
        case "graph.rebuilt":
          pushFeed("✓ graph rebuilt from bundle", "ok");
          break;
      }
    },
    [noteActivity, pushFeed],
  );

  const startSession = useCallback(() => {
    sourceRef.current?.stop();
    setDynNodes([]);
    setDynEdges([]);
    setProposalsByCs({});
    setFeed([]);
    setChangesets([]);
    setHeldMap({});
    setActivity({ count: 0, shine: false, caughtUp: false });
    setStage(0);
    const src = new FileEventSource(`${DB}/events.jsonl`);
    src.subscribe(handleEvent);
    sourceRef.current = src;
    void src.start().catch((e: Error) => pushFeed(`⚠ events file: ${e.message}`, "warn"));
  }, [handleEvent, pushFeed]);

  useEffect(() => {
    if (world) startSession();
    return () => sourceRef.current?.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  const approve = useCallback(
    (changesetId: string) => {
      const held = heldMap[changesetId] ?? [];
      const ids = proposalsByCs[changesetId] ?? [];
      setDynNodes((ns) =>
        ns.map((n) => (ids.includes(n.id) && !held.includes(n.id) ? { ...n, state: "canon" } : n)),
      );
      setDynEdges((es) =>
        es.map((e) => (!held.includes(e.from) && !held.includes(e.to) ? { ...e, state: "canon" } : e)),
      );
      setChangesets((cs) =>
        cs.map((c) => (c.id === changesetId ? { ...c, status: "merged" } : c)),
      );
      handleEvent({ type: "changeset.merged", changesetId });
      setActivity({ count: 0, shine: false, caughtUp: true });
    },
    [handleEvent, heldMap, proposalsByCs],
  );

  /** Guided flight: wherever the user is, take the camera to the knitting site. */
  const flyToSite = useCallback(() => {
    setView({ mode: "interior", bigEventId: KNIT_SITE });
    setSelectedId(world?.interiors[KNIT_SITE]?.nodes[0]?.id ?? null);
    setPanel("review");
    setInspectorOpen(true);
    setActivity((a) => ({ ...a, count: 0, shine: false }));
    if (viewRef.current.mode === "interior" && viewRef.current.bigEventId === KNIT_SITE) {
      framePositions(graphRef, [...labelBus.positions.values()], 1.18, !reducedMotion);
    }
  }, [world, reducedMotion, labelBus]);

  const openNode = useCallback(
    (node: WorldNode) => {
      if (node.kind === "bigEvent" && world?.interiors[node.id]) {
        setView({ mode: "interior", bigEventId: node.id });
        setSelectedId(world.interiors[node.id].nodes[0]?.id ?? null);
        setPanel("record");
        if (node.id === KNIT_SITE) {
          setActivity((a) => ({ ...a, count: 0, shine: false }));
        }
      }
    },
    [world],
  );

  const { nodes, edges } = useMemo(() => {
    if (!world) return { nodes: [] as WorldNode[], edges: [] as WorldEdge[] };
    if (view.mode === "lanes") {
      return {
        nodes: world.laneNodes,
        edges: world.laneEdges,
      };
    }
    const interior = world.interiors[view.bigEventId];
    const mine = dynNodes.filter((n) => n.parent === view.bigEventId);
    const myEdges = dynEdges.filter((e) => e.parent === view.bigEventId);
    return {
      nodes: [...(interior?.nodes ?? []), ...mine],
      edges: [...(interior?.edges ?? []), ...myEdges],
    };
  }, [world, view, dynNodes, dynEdges]);

  const timeline = useMemo(() => arrangeTimeline(nodes, edges, view.mode === "interior"), [nodes, edges, view.mode]);
  const openableIds = useMemo(() => Object.keys(world?.interiors ?? {}), [world]);
  const visibleEdges = useMemo(() => showRelations ? edges : [], [edges, showRelations]);

  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  const selectedIndex = selected ? nodes.indexOf(selected) : 0;
  const pendingCount = changesets.filter((changeset) => changeset.status === "pending").length;
  useEffect(() => {
    inspectorRef.current?.scrollTo(0, 0);
  }, [panel, selected?.id, view.mode, inspectorOpen]);
  const selectNode = (node: WorldNode) => { setSelectedId(node.id); setPanel("record"); setInspectorOpen(true); };
  const activateNode = (node: WorldNode) => {
    if (node.kind === "bigEvent" && world?.interiors[node.id]) { openNode(node); return; }
    selectNode(node);
    if (node.kind !== "character") {
      const positioned = timeline.nodes.find((record) => record.id === node.id) ?? node;
      const position = labelBus.positions.get(node.id) ?? scaledPos(positioned, view.mode === "interior");
      framePositions(graphRef, [position], 1.35, !reducedMotion);
    }
  };
  const stepRecord = (step: number) => {
    if (nodes.length) selectNode(nodes[(selectedIndex + step + nodes.length) % nodes.length]);
  };
  const overview = () => {
    if (view.mode === "interior") setSelectedId(view.bigEventId);
    setView({ mode: "lanes" });
    setPanel("record");
  };

  const labels = useMemo(() => {
    const map: Record<string, string> = { ...(world?.bigEventLabels ?? {}) };
    for (const n of [...(world?.laneNodes ?? []), ...dynNodes]) map[n.id] = n.label;
    for (const group of Object.values(world?.interiors ?? {})) {
      for (const n of group.nodes) map[n.id] = n.label;
    }
    return map;
  }, [world, dynNodes]);

  useEffect(() => {
    labelBus.active = new Set(nodes.map((n) => n.id));
  }, [labelBus, nodes]);

  if (!world) {
    return (
      <main className="loading-screen"><span className="eyebrow">NOVEL / ONTOLOGY PI</span><h1>Narrative archive.</h1><p role={loadError ? "alert" : "status"}>{loadError ? `Could not open the archive: ${loadError}` : "Opening local records…"}</p></main>
    );
  }

  return (
    <div className={`app${reducedMotion ? " reduce-motion" : ""}`}>
      <header className="topbar">
        <button className="brand" onClick={overview} aria-label="Return to archive overview"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M4 32V8h7l18 24h7V8M4 32h7V18l18 14M19 8h17" fill="none" stroke="currentColor" strokeWidth="3" /></svg><span>NOVEL<span>ONTOLOGY / PI</span></span></button>
        <nav aria-label="Workspace navigation">
          <button className={panel === "record" ? "active" : ""} onClick={overview}>Archive <span>↗</span></button>
          <button className={inspectorOpen && panel === "activity" ? "active" : ""} onClick={() => { setPanel("activity"); setInspectorOpen(true); }}>Activity <span>/</span></button>
          <button className={inspectorOpen && panel === "review" ? "active" : ""} onClick={() => { setPanel("review"); setInspectorOpen(true); }}>Review <span>{String(pendingCount).padStart(2, "0")}</span></button>
        </nav>
        <span className="sample-badge"><i />LOCAL SAMPLE</span>
      </header>
      <div className="page-heading">
        <div><div className="eyebrow">COLLECTION 001 / INDEX SAMPLE</div><h1>{view.mode === "lanes" ? "Narrative archive." : world.bigEventLabels[view.bigEventId]}</h1></div>
        <div className={`heading-caption${view.mode === "interior" ? " interior-heading" : ""}`}>{view.mode === "lanes" ? <><span>One world. Parallel stories.</span><small>Click a file or scroll closer to enter.</small></> : <><button className="back-link" onClick={overview}>← Back to chronology</button><small>EVENT INTERIOR / {nodes.length} RECORDS</small></>}</div>
      </div>
      <main className="workspace">
        <section className="scene-panel" aria-label="Archive graph">
          <div className="scene-toolbar"><span className="eyebrow">{view.mode === "lanes" ? "01 / TIMELINE COLLECTION" : "02 / EVENT INTERIOR"}</span><div>
            <span className="direction-label">Narrative order →</span>
            <button aria-pressed={showRelations} onClick={() => setShowRelations(!showRelations)}>{showRelations ? "Relations on" : "Relations off"}</button>
            <button onClick={() => framePositions(graphRef, labelBus.positions.size ? [...labelBus.positions.values()] : timeline.nodes.map((node) => scaledPos(node, view.mode === "interior")), 1.18, !reducedMotion)}>Frame view ⌖</button>
          </div></div>
          <div className="stage" tabIndex={0} aria-label="3D records. Arrow keys select, Enter opens an event, Escape returns to chronology." onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key === "ArrowRight" || event.key === "ArrowLeft") { event.preventDefault(); stepRecord(event.key === "ArrowRight" ? 1 : -1); }
            if (event.key === "Enter" && selected) { event.preventDefault(); openNode(selected); }
            if (event.key === "Escape") overview();
          }}>
            <div className="graph-canvas"><WorldGraph ref={graphRef} nodes={timeline.nodes} edges={visibleEdges} tracks={timeline.tracks} interior={view.mode === "interior"} viewId={view.mode === "lanes" ? "lanes" : view.bigEventId} openableIds={openableIds} labelBus={labelBus} selectedId={selected?.id ?? null} reducedMotion={reducedMotion} onNodeClick={activateNode} onNodeOpen={openNode} onViewBack={overview} /></div>
            <div className="scene-coordinate" aria-hidden="true">N / O<br /><span>ARCHIVE<br />EXPLORER</span></div>
            <div className="labels-layer">
              {nodes.map((node, index) => <button key={node.id} className={`node-label k-${node.kind} s-${node.state}${selected?.id === node.id ? " is-selected" : ""}`} style={{ visibility: "hidden" }} aria-label={`${openableIds.includes(node.id) ? "Open" : "Select"} ${node.label}`} aria-pressed={selected?.id === node.id} ref={(element) => { if (element) labelBus.targets.set(node.id, element); else labelBus.targets.delete(node.id); }} onClick={() => activateNode(node)}>
                <span className="node-code">{String(index + 1).padStart(2, "0")} / {node.lane.toUpperCase()}</span><b>{node.label}</b><span>{node.state !== "canon" ? node.state.toUpperCase() : KIND_LABEL[node.kind]}</span>
                {node.kind === "bigEvent" && dynNodes.some((child) => child.parent === node.id && child.state !== "canon") && <em className="node-updates">{dynNodes.filter((child) => child.parent === node.id && child.state !== "canon").length} IN REVIEW</em>}
              </button>)}
            </div>
            <div className="track-labels">{timeline.tracks.map((track) => <span key={track.id} className="track-label" ref={(element) => { if (element) labelBus.trackTargets.set(track.id, element); else labelBus.trackTargets.delete(track.id); }}>{track.label}<small>SEQUENCE →</small></span>)}</div>
            <div className="stage-bottom"><span>CLICK TO ENTER / SCROLL TO ZOOM</span><span>{timeline.tracks.length} TRACKS · {nodes.length} RECORDS</span></div>
          </div>
          <div className="scene-legend"><span><i className="canon" />Canon</span><span><i className="branch" />Branch</span><span><i className="proposed" />Proposed</span><span><i className="held" />Held</span><button aria-pressed={reducedMotion} onClick={() => setReducedMotion(!reducedMotion)}>{reducedMotion ? "Motion reduced" : "Motion on"}</button></div>
        </section>
        <aside className={`inspector${inspectorOpen ? " is-open" : ""}`} aria-label="Record and processing details">
          <div className="inspector-tabs" role="tablist" aria-orientation="vertical" aria-label="Inspector">
            {(["record", "activity", "review"] as const).map((tab, index, tabs) => <button key={tab} id={`tab-${tab}`} role="tab" tabIndex={panel === tab ? 0 : -1} aria-selected={inspectorOpen && panel === tab} aria-controls={`panel-${tab}`} onClick={() => { setInspectorOpen(panel === tab ? !inspectorOpen : true); setPanel(tab); }} onKeyDown={(event) => {
              if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
              setPanel(tabs[next]);
              setInspectorOpen(true);
              document.getElementById(`tab-${tabs[next]}`)?.focus();
            }}>{tab}{tab === "review" && pendingCount > 0 && <span>{pendingCount}</span>}</button>)}
          </div>
          <div className="inspector-sheet" hidden={!inspectorOpen}>
          <div className="sheet-heading"><span className="eyebrow">ARCHIVE / {panel}</span><button aria-label="Close details" onClick={() => { setInspectorOpen(false); document.getElementById(`tab-${panel}`)?.focus(); }}>×</button></div>
          <div ref={inspectorRef} className="inspector-body" id={`panel-${panel}`} role="tabpanel" aria-labelledby={`tab-${panel}`}>
            {panel === "record" && <RecordInspector selected={selected} nodes={nodes} edges={edges} childCount={selected ? (world.interiors[selected.id]?.nodes.length ?? 0) + dynNodes.filter((node) => node.parent === selected.id).length : 0} canOpen={!!selected && !!world.interiors[selected.id]} onSelect={activateNode} />}
            {panel === "activity" && <><div className="panel-intro"><span className="eyebrow">PROCESSING JOURNAL</span><h2>In the making.</h2><p>{blockLabel ?? "Waiting for the sample session."}</p><button onClick={startSession}>Replay sample ↻</button></div><DecisionFeed entries={feed} /></>}
            {panel === "review" && <><div className="panel-intro"><span className="eyebrow">THE MERGE GATE</span><h2>Before it is canon.</h2><p>Review the sample proposals. Held records stay separate when the rest merge.</p></div><GateQueue changesets={changesets} heldMap={heldMap} labels={labels} onApprove={approve} /></>}
          </div>
          </div>
        </aside>
        <div className="activity-dock"><ActivityTab count={activity.count} shine={activity.shine} caughtUp={activity.caughtUp} onClick={flyToSite} /></div>
      </main>
      <PipelineStrip stage={stage} />
      <footer className="transport">
        <div className="selection-counter"><span className="eyebrow">RECORD / SELECT</span><div>{String(selected ? selectedIndex + 1 : 0).padStart(2, "0")}<small>/ {String(nodes.length).padStart(2, "0")}</small></div></div>
        <div className="record-transport"><button className="arrow-button" aria-label="Previous record" disabled={!nodes.length} onClick={() => stepRecord(-1)}>←</button><div><strong>{selected?.label ?? "Archive"}</strong><span>{selected ? `${KIND_LABEL[selected.kind]} / ${selected.lane}` : "No records"}</span></div><button className="arrow-button" aria-label="Next record" disabled={!nodes.length} onClick={() => stepRecord(1)}>→</button></div>
        <div className="session-controls"><span className="eyebrow">LOCAL FILE REPLAY / DEMO</span><button onClick={startSession}>Replay session ↻</button></div>
      </footer>
    </div>
  );
}
