import { useEffect, useState } from "react";
import { fetchJSON } from "../api";

interface Tool {
  id: number;
  name: string;
  type: string;
  description: string | null;
  input_desc: string | null;
  output_desc: string | null;
  remote_host: string | null;
  remote_path: string | null;
}

interface DataUpdate {
  id: number;
  source_path: string;
  status: string;
  total_frames: number | null;
  created_at: string;
}

const typeColors: Record<string, string> = {
  dag_template: "bg-blue-500/20 text-blue-400",
  data_script: "bg-purple-500/20 text-purple-400",
};

function ToolList({ tools, emptyText }: { tools: Tool[]; emptyText: string }) {
  const [expandedId, setExpandedId] = useState<number | null>(null);

  return (
    <div className="space-y-1">
      {tools.map((t) => (
        <div key={t.id}>
          <div
            onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
            className="px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeColors[t.type] || "bg-muted/20 text-muted"}`}>
                {t.type === "dag_template" ? "DAG" : "Script"}
              </span>
              <span className="text-xs text-white font-medium">{t.name}</span>
            </div>
            {t.description && <p className="text-xs text-muted mt-0.5 line-clamp-1">{t.description}</p>}
          </div>

          {expandedId === t.id && (
            <div className="mx-3 mb-2 p-3 bg-surface rounded-lg border border-border/50 text-xs space-y-2">
              {t.description && (
                <div>
                  <span className="text-muted text-[10px] uppercase tracking-wider">Description</span>
                  <p className="text-gray-300 mt-0.5">{t.description}</p>
                </div>
              )}
              {t.input_desc && (
                <div>
                  <span className="text-muted text-[10px] uppercase tracking-wider">Input</span>
                  <p className="text-gray-300 mt-0.5">{t.input_desc}</p>
                </div>
              )}
              {t.output_desc && (
                <div>
                  <span className="text-muted text-[10px] uppercase tracking-wider">Output</span>
                  <p className="text-gray-300 mt-0.5">{t.output_desc}</p>
                </div>
              )}
              {t.remote_path && (
                <div>
                  <span className="text-muted text-[10px] uppercase tracking-wider">Remote</span>
                  <p className="text-gray-300 font-mono mt-0.5">{t.remote_host ? `${t.remote_host}:` : ""}{t.remote_path}</p>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
      {tools.length === 0 && (
        <div className="text-center text-muted py-6 text-xs">{emptyText}</div>
      )}
    </div>
  );
}

const DATA_TOOLS = new Set(["raw_L3_OD_anno_to_pkl", "raw_L3_FS_anno_to_pkl"]);

function ToolsSection() {
  const [tools, setTools] = useState<Tool[]>([]);
  useEffect(() => {
    fetchJSON<Tool[]>("/api/tools").then((all) => setTools(all.filter((t) => !DATA_TOOLS.has(t.name)))).catch(console.error);
  }, []);
  return <ToolList tools={tools} emptyText="No pipeline tools registered" />;
}

function DataSection() {
  const [tools, setTools] = useState<Tool[]>([]);
  useEffect(() => {
    fetchJSON<Tool[]>("/api/tools").then((all) => setTools(all.filter((t) => DATA_TOOLS.has(t.name)))).catch(console.error);
  }, []);
  return <ToolList tools={tools} emptyText="No data scripts registered" />;
}

function DataStatsSection() {
  const [updates, setUpdates] = useState<DataUpdate[]>([]);

  useEffect(() => {
    fetchJSON<DataUpdate[]>("/api/data-update/status").then(setUpdates).catch(console.error);
  }, []);

  const statusColor: Record<string, string> = {
    pending: "bg-muted",
    running: "bg-yellow-500 animate-pulse",
    completed: "bg-green-500",
    failed: "bg-red-500",
  };

  return (
    <div className="space-y-1">
      {updates.map((u) => (
        <div key={u.id} className="px-3 py-2 rounded-lg hover:bg-surface-hover transition-colors text-xs">
          <div className="flex items-center justify-between">
            <span className="text-white font-medium">Update #{u.id}</span>
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${statusColor[u.status] || "bg-muted"}`} />
              <span className="text-muted">{u.status}</span>
            </span>
          </div>
          <p className="text-muted font-mono mt-0.5 truncate">{u.source_path}</p>
          <div className="flex gap-3 mt-0.5 text-muted/60">
            {u.total_frames && <span>{u.total_frames} frames</span>}
            <span>{new Date(u.created_at).toLocaleString()}</span>
          </div>
        </div>
      ))}
      {updates.length === 0 && (
        <div className="text-center text-muted py-6 text-xs">
          No data processing runs yet
        </div>
      )}
    </div>
  );
}

export default function Pipeline() {
  const [section, setSection] = useState<"tools" | "data">("tools");

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 flex border-b border-border">
        <button
          onClick={() => setSection("tools")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            section === "tools" ? "text-white border-b-2 border-tesla-red" : "text-muted hover:text-white"
          }`}
        >
          Tools
        </button>
        <button
          onClick={() => setSection("data")}
          className={`flex-1 px-3 py-2 text-xs font-medium transition-colors ${
            section === "data" ? "text-white border-b-2 border-tesla-red" : "text-muted hover:text-white"
          }`}
        >
          Data
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2">
        {section === "tools" ? <ToolsSection /> : <DataSection />}
      </div>
    </div>
  );
}
