interface StageInfo {
  stage_id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
}

const statusConfig: Record<string, { color: string; dot: string }> = {
  pending: { color: "text-muted", dot: "bg-muted" },
  running: { color: "text-yellow-400", dot: "bg-yellow-500 animate-pulse" },
  completed: { color: "text-green-400", dot: "bg-green-500" },
  failed: { color: "text-red-400", dot: "bg-red-500" },
};

export default function DAGViewer({ stages }: { stages: StageInfo[] }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4 space-y-2">
      {stages.map((s, i) => {
        const cfg = statusConfig[s.status] || statusConfig.pending;
        return (
          <div key={s.stage_id}>
            {i > 0 && <div className="w-px h-3 bg-border ml-5 my-1" />}
            <div className="flex items-center gap-3 px-4 py-3 rounded-lg hover:bg-surface-hover transition-colors">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${cfg.dot}`} />
              <span className="text-sm text-white font-medium">{s.stage_id}</span>
              <span className={`text-xs ml-auto ${cfg.color}`}>{s.status}</span>
              {s.started_at && <span className="text-xs text-muted">{s.started_at}</span>}
            </div>
          </div>
        );
      })}
      {stages.length === 0 && <p className="text-center text-muted text-sm py-8">No stages to display</p>}
    </div>
  );
}
