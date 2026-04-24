import { useEffect, useState, useRef, useCallback } from "react";
import { fetchJSON } from "../api";

interface VolcTask {
  id: number;
  volc_task_id: string;
  name: string;
  queue: string;
  queue_label: string;
  status: string;
  workers: number;
  creator: string;
  created_at: string | null;
  synced_at: string;
}

interface Experiment {
  id: number;
  name: string;
  status: string;
}

interface MetricDiff {
  task_type: string;
  metric_name: string;
  value_a: number;
  value_b: number;
  delta: number;
}

const statusColor: Record<string, string> = {
  Running: "bg-yellow-500 animate-pulse",
  Success: "bg-green-500",
  Failed: "bg-red-500",
  Cancelled: "bg-muted",
  Stopped: "bg-muted",
  Pending: "bg-blue-500",
  created: "bg-blue-500",
  running: "bg-yellow-500",
  completed: "bg-green-500",
  failed: "bg-red-500",
};

function TasksTab() {
  const [tasks, setTasks] = useState<VolcTask[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncElapsed, setSyncElapsed] = useState(0);
  const [filterQueue, setFilterQueue] = useState("");
  const [filterStatus, setFilterStatus] = useState("");

  async function load() {
    const params = new URLSearchParams();
    if (filterQueue) params.set("queue", filterQueue);
    if (filterStatus) params.set("status", filterStatus);
    const data = await fetchJSON<VolcTask[]>(`/api/experiments/volc-tasks?${params}`);
    setTasks(data);
    return data;
  }

  async function sync() {
    setSyncing(true);
    setSyncElapsed(0);
    const timer = setInterval(() => setSyncElapsed((p) => p + 1), 1000);
    try {
      await fetchJSON("/api/experiments/volc-tasks/sync", { method: "POST" });
      await load();
    } finally {
      clearInterval(timer);
      setSyncing(false);
    }
  }

  useEffect(() => {
    load().then((data) => {
      if (!data || data.length === 0) sync();
    });
  }, []);
  useEffect(() => { load(); }, [filterQueue, filterStatus]);

  const queues = [...new Set(tasks.map((t) => t.queue).filter(Boolean))];
  const statuses = [...new Set(tasks.map((t) => t.status).filter(Boolean))];

  return (
    <div className="p-3 space-y-3">
      <div className="flex gap-2 items-center">
        <select
          value={filterQueue}
          onChange={(e) => setFilterQueue(e.target.value)}
          className="bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-tesla-red"
        >
          <option value="">All queues</option>
          {queues.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-tesla-red"
        >
          <option value="">All statuses</option>
          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button
          onClick={sync}
          disabled={syncing}
          className="ml-auto flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors disabled:opacity-50"
        >
          <svg className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? "Syncing..." : "Refresh"}
        </button>
      </div>

      {syncing && (
        <div className="bg-surface border border-border rounded-lg p-3 flex items-center gap-3">
          <svg className="w-4 h-4 text-tesla-red animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-white">Syncing tasks from Volc...</p>
            <p className="text-[10px] text-muted mt-0.5">Querying ledger tasks + same-name discovery &middot; {syncElapsed}s</p>
            <div className="mt-1.5 h-1 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-tesla-red rounded-full animate-pulse" style={{ width: "100%" }} />
            </div>
          </div>
        </div>
      )}

      <div className="space-y-1">
        {tasks.map((t) => (
          <div key={t.id} className="px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-xs">
            <div className="flex items-center justify-between">
              <span className="text-white font-medium truncate">{t.name || t.volc_task_id}</span>
              <span className="inline-flex items-center gap-1.5 shrink-0 ml-2">
                <span className={`w-1.5 h-1.5 rounded-full ${statusColor[t.status] || "bg-muted"}`} />
                <span className="text-muted">{t.status}</span>
              </span>
            </div>
            <div className="flex gap-3 mt-0.5 text-muted/60">
              <span className="font-mono">{t.volc_task_id}</span>
              {t.queue_label && <span>{t.queue_label}</span>}
              {t.workers > 0 && <span>{t.workers}w</span>}
              {t.created_at && <span>{new Date(t.created_at).toLocaleString()}</span>}
            </div>
          </div>
        ))}
        {tasks.length === 0 && (
          <div className="text-center text-muted py-8 text-xs">
            No tasks. Click Refresh to sync from Volc.
          </div>
        )}
      </div>
    </div>
  );
}

function GraphTab() {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<number[]>([]);
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [compareResult, setCompareResult] = useState<MetricDiff[] | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ zoom: 0.3, panX: 0, panY: 0 });

  useEffect(() => {
    fetch("/api/experiments/tree-svg")
      .then((r) => { if (!r.ok) throw new Error(); return r.text(); })
      .then((svg) => setImgSrc(svg))
      .catch(() => setError(true));
    fetchJSON<Experiment[]>("/api/experiments").then(setExperiments).catch(() => {});
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let dragging = false;
    let lastX = 0, lastY = 0;

    function apply() {
      if (innerRef.current) {
        const s = stateRef.current;
        innerRef.current.style.transform = `translate(${s.panX}px,${s.panY}px) scale(${s.zoom})`;
      }
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const s = stateRef.current;
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.min(10, Math.max(0.05, s.zoom * factor));
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      s.panX = mx - (mx - s.panX) * (newZoom / s.zoom);
      s.panY = my - (my - s.panY) * (newZoom / s.zoom);
      s.zoom = newZoom;
      apply();
      setRenderTick((n) => n + 1);
    }

    function onDown(e: MouseEvent) {
      if (e.button !== 0) return;
      // Don't start drag if clicking a node (let click handler fire instead)
      const target = e.target as Element;
      if (target.closest('[id^="node-"]')) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    }

    function onMove(e: MouseEvent) {
      if (!dragging) return;
      e.preventDefault();
      const s = stateRef.current;
      s.panX += e.clientX - lastX;
      s.panY += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      apply();
    }

    function onUp() { dragging = false; }

    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [imgSrc]);

  // Attach click handlers to SVG node elements via event delegation
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner || !imgSrc) return;
    // Set cursor on all nodes
    inner.querySelectorAll('[id^="node-"]').forEach((n) => {
      (n as HTMLElement).style.cursor = "pointer";
    });
    // Single delegated click handler on the inner container
    const handler = (e: MouseEvent) => {
      const target = (e.target as Element).closest('[id^="node-"]');
      if (!target) return;
      const id = target.id.replace("node-", "");
      const num = parseInt(id);
      if (isNaN(num)) return;
      e.stopPropagation();
      setSelectedNodes((prev) => {
        if (prev.includes(num)) return prev.filter((n) => n !== num);
        if (prev.length >= 2) return [prev[1], num];
        return [...prev, num];
      });
      setCompareResult(null);
    };
    inner.addEventListener("click", handler);
    return () => { inner.removeEventListener("click", handler); };
  }, [imgSrc]);

  // Highlight selected nodes in SVG
  useEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    inner.querySelectorAll('[id^="node-"]').forEach((n) => {
      const id = parseInt(n.id.replace("node-", ""));
      const paths = n.querySelectorAll("path");
      paths.forEach((p) => {
        if (selectedNodes.includes(id)) {
          p.setAttribute("stroke", "#e82127");
          p.setAttribute("stroke-width", "4");
        } else {
          p.setAttribute("stroke-width", "");
          p.setAttribute("stroke", "");
        }
      });
    });
  }, [selectedNodes, imgSrc]);

  function resetView() {
    stateRef.current = { zoom: 0.3, panX: 0, panY: 0 };
    if (innerRef.current) innerRef.current.style.transform = "translate(0px,0px) scale(0.3)";
    setRenderTick((n) => n + 1);
  }

  function zoomBtn(factor: number) {
    const s = stateRef.current;
    s.zoom = Math.min(10, Math.max(0.05, s.zoom * factor));
    if (innerRef.current) innerRef.current.style.transform = `translate(${s.panX}px,${s.panY}px) scale(${s.zoom})`;
    setRenderTick((n) => n + 1);
  }

  async function compare() {
    if (selectedNodes.length !== 2) return;
    const data = await fetchJSON<MetricDiff[]>(
      `/api/experiments/${selectedNodes[0]}/compare/${selectedNodes[1]}`
    );
    setCompareResult(data);
  }

  function toggleNode(id: number) {
    setSelectedNodes((prev) => {
      if (prev.includes(id)) return prev.filter((n) => n !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
    setCompareResult(null);
  }

  return (
    <div className="p-3 flex flex-col h-full">
      {imgSrc ? (
        <>
          <div className="shrink-0 flex items-center gap-1 mb-2">
            <button onClick={() => zoomBtn(1.3)} className="w-7 h-7 rounded bg-surface border border-border text-white text-sm hover:bg-surface-hover transition-colors flex items-center justify-center">+</button>
            <button onClick={() => zoomBtn(0.7)} className="w-7 h-7 rounded bg-surface border border-border text-white text-sm hover:bg-surface-hover transition-colors flex items-center justify-center">-</button>
            <button onClick={resetView} className="h-7 px-2 rounded bg-surface border border-border text-muted text-[10px] hover:bg-surface-hover hover:text-white transition-colors">Reset</button>
            <span className="text-[10px] text-muted ml-1">{Math.round(stateRef.current.zoom * 100)}%</span>
          </div>
          <div
            ref={containerRef}
            style={{ flex: "1 1 0", minHeight: 300, position: "relative", overflow: "hidden", borderRadius: 8, border: "1px solid var(--color-border)", cursor: "grab", userSelect: "none" }}
          >
            <div
              ref={innerRef}
              dangerouslySetInnerHTML={{ __html: imgSrc }}
              style={{ position: "absolute", transformOrigin: "0 0", transform: "translate(0px,0px) scale(0.3)", willChange: "transform" }}
            />
          </div>
        </>
      ) : error ? (
        <div className="text-center text-muted py-8 text-xs">
          No experiment tree image found
        </div>
      ) : (
        <div className="text-center text-muted py-8 text-xs">Loading graph...</div>
      )}

      {selectedNodes.length > 0 && (
        <div className="shrink-0 flex items-center gap-2 mt-2">
          <span className="text-[10px] text-muted">
            Selected: {selectedNodes.map((n) => `#${n}`).join(", ")}
            {selectedNodes.length < 2 && " — click another node to compare"}
          </span>
          {selectedNodes.length === 2 && (
            <button
              onClick={compare}
              className="bg-tesla-red hover:bg-tesla-red-hover text-white px-3 py-1 rounded text-xs font-medium transition-colors"
            >
              Compare
            </button>
          )}
          <button
            onClick={() => { setSelectedNodes([]); setCompareResult(null); }}
            className="text-muted hover:text-white text-xs transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Compare modal */}
      {compareResult && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setCompareResult(null)}>
          <div className="bg-bg border border-border rounded-xl p-4 max-w-lg w-full mx-4 max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-white">
                Comparison: #{selectedNodes[0]} vs #{selectedNodes[1]}
              </h3>
              <button onClick={() => setCompareResult(null)} className="text-muted hover:text-white text-lg">&times;</button>
            </div>
            {compareResult.length === 0 ? (
              <p className="text-muted text-xs">No common metrics to compare</p>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-muted">
                    <th className="text-left py-2 font-medium">Task / Metric</th>
                    <th className="text-right py-2 font-medium">A</th>
                    <th className="text-right py-2 font-medium">B</th>
                    <th className="text-right py-2 font-medium">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {compareResult.map((r, i) => (
                    <tr key={i} className="border-b border-border/50">
                      <td className="py-1.5 text-muted">{r.task_type} / {r.metric_name}</td>
                      <td className="py-1.5 text-right font-mono text-white">{r.value_a.toFixed(4)}</td>
                      <td className="py-1.5 text-right font-mono text-white">{r.value_b.toFixed(4)}</td>
                      <td className={`py-1.5 text-right font-mono ${r.delta > 0 ? "text-green-400" : r.delta < 0 ? "text-red-400" : "text-muted"}`}>
                        {r.delta > 0 ? "+" : ""}{r.delta.toFixed(4)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Dashboard() {
  const [tab, setTab] = useState<"tasks" | "graph">("tasks");

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex border-b border-border">
        <button
          onClick={() => setTab("tasks")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === "tasks" ? "text-white border-b-2 border-tesla-red" : "text-muted hover:text-white"
          }`}
        >
          Tasks
        </button>
        <button
          onClick={() => setTab("graph")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            tab === "graph" ? "text-white border-b-2 border-tesla-red" : "text-muted hover:text-white"
          }`}
        >
          Graph
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        {tab === "tasks" ? <TasksTab /> : <GraphTab />}
      </div>
    </div>
  );
}
