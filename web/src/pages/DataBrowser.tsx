import { useEffect, useState } from "react";
import { fetchJSON } from "../api";

interface Dataset {
  id: number;
  name: string;
  version: string | null;
  role: string | null;
  remote_path: string | null;
  pkl_files_json: string | null;
  total_frames: number | null;
  class_distribution_json: string | null;
  train_frames: number | null;
  val_frames: number | null;
  synced_at: string;
}

interface ActiveVis {
  pklPath: string;
  url: string;
  port: number;
  pid: number;
  loading: boolean;
}

type Tab = "train" | "val";

const CLASSES = ["car", "bus", "truck", "cyclist", "pedestrian", "barrier"];

function ClassDistribution({ json }: { json: string | null }) {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as Record<string, number>;
    const max = Math.max(...Object.values(data), 1);
    return (
      <div className="space-y-1">
        {CLASSES.map((cls) => {
          const count = data[cls] || 0;
          const pct = (count / max) * 100;
          return (
            <div key={cls} className="flex items-center gap-2 text-[10px]">
              <span className="w-16 text-muted text-right">{cls}</span>
              <div className="flex-1 h-2 bg-surface rounded-full overflow-hidden">
                <div className="h-full bg-tesla-red/60 rounded-full" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-12 text-muted text-right font-mono">{count.toLocaleString()}</span>
            </div>
          );
        })}
      </div>
    );
  } catch {
    return null;
  }
}

function FileRow({
  path,
  activeVis,
  onStartVis,
  onStopVis,
}: {
  path: string;
  activeVis: ActiveVis | null;
  onStartVis: () => void;
  onStopVis: () => void;
}) {
  const filename = path.split("/").pop() || path;
  const isThis = activeVis?.pklPath === path;
  const isOtherRunning = activeVis !== null && !isThis && !activeVis.loading;

  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded transition-colors group ${
      isThis && !activeVis.loading ? "bg-green-900/10 border border-green-900/30" : "hover:bg-surface-hover"
    }`}>
      <svg className="w-3 h-3 text-muted/40 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] text-gray-300 font-mono truncate" title={path}>{filename}</p>
        <p className="text-[9px] text-muted/40 font-mono truncate" title={path}>{path}</p>
      </div>

      <div className="shrink-0">
        {isThis && activeVis.loading ? (
          <span className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] text-muted">
            <svg className="w-2.5 h-2.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Starting...
          </span>
        ) : isThis ? (
          <div className="flex items-center gap-1">
            <a
              href={activeVis.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] text-green-400 hover:text-green-300 bg-green-900/20 rounded transition-colors"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
              </svg>
              Open
            </a>
            <button
              onClick={onStopVis}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] text-red-400 hover:text-red-300 bg-red-900/20 rounded transition-colors"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 7.5A2.25 2.25 0 017.5 5.25h9a2.25 2.25 0 012.25 2.25v9a2.25 2.25 0 01-2.25 2.25h-9a2.25 2.25 0 01-2.25-2.25v-9z" />
              </svg>
              Stop
            </button>
          </div>
        ) : (
          <button
            onClick={onStartVis}
            disabled={activeVis?.loading}
            className={`flex items-center gap-1 px-1.5 py-0.5 text-[9px] text-muted hover:text-white bg-surface-hover rounded transition-colors ${
              isOtherRunning ? "" : "opacity-0 group-hover:opacity-100"
            } disabled:opacity-30`}
            title={isOtherRunning ? "Will stop current viewer and switch to this file" : undefined}
          >
            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {isOtherRunning ? "Switch" : "Visualize"}
          </button>
        )}
      </div>
    </div>
  );
}

export default function DataBrowser() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [scanning, setScanning] = useState(false);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [activeVis, setActiveVis] = useState<ActiveVis | null>(null);
  const [tab, setTab] = useState<Tab>("train");

  async function load() {
    const data = await fetchJSON<Dataset[]>("/api/datasets");
    setDatasets(data);
  }

  async function scan() {
    setScanning(true);
    try {
      await fetchJSON("/api/datasets/scan", { method: "POST" });
      await load();
    } finally {
      setScanning(false);
    }
  }

  async function refresh(id: number) {
    setRefreshingId(id);
    try {
      await fetchJSON(`/api/datasets/${id}/refresh`, { method: "POST" });
      await load();
    } finally {
      setRefreshingId(null);
    }
  }

  async function startVis(filePath: string) {
    setActiveVis({ pklPath: filePath, url: "", port: 0, pid: 0, loading: true });
    try {
      const result = await fetchJSON<{ url: string; port: number; pid: number }>(
        "/api/datasets/file/visualize",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: filePath }) },
      );
      setActiveVis({ pklPath: filePath, ...result, loading: false });
    } catch {
      setActiveVis(null);
    }
  }

  async function stopVis() {
    try {
      await fetchJSON(
        "/api/datasets/file/visualize/stop",
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
    } finally {
      setActiveVis(null);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = datasets.filter((ds) => ds.role === tab);

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="shrink-0 border-b border-border">
        <div className="flex items-center justify-between px-3 pt-2">
          <div className="flex gap-1">
            <button
              onClick={() => setTab("train")}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                tab === "train"
                  ? "bg-surface text-white border border-border border-b-transparent -mb-px"
                  : "text-muted hover:text-white"
              }`}
            >
              Training
            </button>
            <button
              onClick={() => setTab("val")}
              className={`px-3 py-1.5 text-xs font-medium rounded-t transition-colors ${
                tab === "val"
                  ? "bg-surface text-white border border-border border-b-transparent -mb-px"
                  : "text-muted hover:text-white"
              }`}
            >
              Evaluation
            </button>
          </div>
          <button
            onClick={scan}
            disabled={scanning}
            className="flex items-center gap-1.5 text-xs text-muted hover:text-white transition-colors disabled:opacity-50"
          >
            <svg className={`w-3.5 h-3.5 ${scanning ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {scanning ? "Scanning..." : "Scan Remote"}
          </button>
        </div>
      </div>

      {/* Content for active tab */}
      <div className="flex-1 overflow-auto">
        {filtered.map((ds) => {
          let pklFiles: string[] = [];
          try {
            if (ds.pkl_files_json) pklFiles = JSON.parse(ds.pkl_files_json);
          } catch {}

          return (
            <div key={ds.id} className="p-2">
              {/* Summary + refresh */}
              <div className="flex items-center justify-between px-2 mb-2">
                <div className="flex gap-3 text-[10px] text-muted/60">
                  <span>{pklFiles.length} files</span>
                  {ds.total_frames != null && <span>{ds.total_frames.toLocaleString()} frames</span>}
                  <span>synced {new Date(ds.synced_at).toLocaleDateString()}</span>
                </div>
                <button
                  onClick={() => refresh(ds.id)}
                  disabled={refreshingId === ds.id}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] text-muted hover:text-white bg-surface-hover rounded transition-colors disabled:opacity-50"
                >
                  <svg className={`w-3 h-3 ${refreshingId === ds.id ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {refreshingId === ds.id ? "Refreshing..." : "Refresh"}
                </button>
              </div>

              {/* File list — each row has its own Visualize button */}
              <div className="space-y-0.5">
                {pklFiles.map((f) => (
                  <FileRow
                    key={f}
                    path={f}
                    activeVis={activeVis}
                    onStartVis={() => startVis(f)}
                    onStopVis={stopVis}
                  />
                ))}
              </div>

              {/* Stats + class distribution */}
              {(ds.total_frames != null || ds.class_distribution_json) && (
                <div className="mt-3 px-2 pt-2 border-t border-border/30 space-y-2">
                  {ds.total_frames != null && (
                    <div className="flex gap-4">
                      <div>
                        <span className="text-muted text-[10px] uppercase tracking-wider">Total</span>
                        <p className="text-white font-mono text-xs mt-0.5">{ds.total_frames.toLocaleString()}</p>
                      </div>
                      {ds.train_frames != null && (
                        <div>
                          <span className="text-muted text-[10px] uppercase tracking-wider">Train</span>
                          <p className="text-white font-mono text-xs mt-0.5">{ds.train_frames.toLocaleString()}</p>
                        </div>
                      )}
                      {ds.val_frames != null && (
                        <div>
                          <span className="text-muted text-[10px] uppercase tracking-wider">Val</span>
                          <p className="text-white font-mono text-xs mt-0.5">{ds.val_frames.toLocaleString()}</p>
                        </div>
                      )}
                    </div>
                  )}
                  <ClassDistribution json={ds.class_distribution_json} />
                </div>
              )}
            </div>
          );
        })}

        {filtered.length === 0 && (
          <div className="text-center text-muted py-8 text-xs">
            No {tab === "train" ? "training" : "evaluation"} datasets. Click "Scan Remote" to discover.
          </div>
        )}
      </div>
    </div>
  );
}
