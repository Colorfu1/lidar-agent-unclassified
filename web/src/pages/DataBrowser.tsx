import { useEffect, useState } from "react";
import { fetchJSON } from "../api";

interface Dataset {
  id: number;
  name: string;
  version: string | null;
  remote_path: string | null;
  total_frames: number | null;
  class_distribution_json: string | null;
  train_frames: number | null;
  val_frames: number | null;
  synced_at: string;
}

const CLASSES = ["car", "bus", "truck", "cyclist", "pedestrian", "barrier"];

function ClassDistribution({ json }: { json: string | null }) {
  if (!json) return null;
  try {
    const data = JSON.parse(json) as Record<string, number>;
    const max = Math.max(...Object.values(data), 1);
    return (
      <div className="space-y-1 mt-2">
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

export default function DataBrowser() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [scanning, setScanning] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

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

  useEffect(() => { load(); }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 p-3 border-b border-border flex items-center justify-between">
        <span className="text-xs text-muted">{datasets.length} datasets</span>
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

      <div className="flex-1 overflow-auto p-2">
        <div className="space-y-1">
          {datasets.map((ds) => (
            <div key={ds.id}>
              <div
                onClick={() => setExpandedId(expandedId === ds.id ? null : ds.id)}
                className="px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white font-medium">{ds.name}</span>
                  {ds.version && <span className="text-[10px] text-muted font-mono">{ds.version}</span>}
                </div>
                <div className="flex gap-3 mt-0.5 text-[10px] text-muted/60">
                  {ds.total_frames != null && <span>{ds.total_frames.toLocaleString()} frames</span>}
                  {ds.train_frames != null && ds.val_frames != null && (
                    <span>train: {ds.train_frames.toLocaleString()} / val: {ds.val_frames.toLocaleString()}</span>
                  )}
                  <span>{new Date(ds.synced_at).toLocaleDateString()}</span>
                </div>
              </div>

              {expandedId === ds.id && (
                <div className="mx-3 mb-2 p-3 bg-surface rounded-lg border border-border/50 text-xs space-y-2">
                  {ds.remote_path && (
                    <div>
                      <span className="text-muted text-[10px] uppercase tracking-wider">Remote Path</span>
                      <p className="text-gray-300 font-mono mt-0.5 text-[11px]">{ds.remote_path}</p>
                    </div>
                  )}
                  {ds.total_frames != null && (
                    <div className="flex gap-4">
                      <div>
                        <span className="text-muted text-[10px] uppercase tracking-wider">Total</span>
                        <p className="text-white font-mono mt-0.5">{ds.total_frames.toLocaleString()}</p>
                      </div>
                      {ds.train_frames != null && (
                        <div>
                          <span className="text-muted text-[10px] uppercase tracking-wider">Train</span>
                          <p className="text-white font-mono mt-0.5">{ds.train_frames.toLocaleString()}</p>
                        </div>
                      )}
                      {ds.val_frames != null && (
                        <div>
                          <span className="text-muted text-[10px] uppercase tracking-wider">Val</span>
                          <p className="text-white font-mono mt-0.5">{ds.val_frames.toLocaleString()}</p>
                        </div>
                      )}
                    </div>
                  )}
                  <ClassDistribution json={ds.class_distribution_json} />
                </div>
              )}
            </div>
          ))}
          {datasets.length === 0 && (
            <div className="text-center text-muted py-8 text-xs">
              No datasets. Click "Scan Remote" to discover.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
