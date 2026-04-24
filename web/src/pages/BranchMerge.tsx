import { useEffect, useState } from "react";
import { fetchJSON } from "../api";
import DiffViewer from "../components/DiffViewer";

interface Branch { name: string; lastCommit: string; }
interface FileDiff { path: string; status: string; diff: string; }

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
  status?: string;
  diff?: string;
}

function buildTree(diffs: FileDiff[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const d of diffs) {
    const parts = d.path.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isLast = i === parts.length - 1;
      let node = current.find((n) => n.name === name);
      if (!node) {
        node = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: [],
          status: isLast ? d.status : undefined,
          diff: isLast ? d.diff : undefined,
        };
        current.push(node);
      }
      current = node.children;
    }
  }
  return root;
}

const statusBadge: Record<string, string> = {
  M: "text-yellow-400",
  A: "text-green-400",
  D: "text-red-400",
};

function FileTree({
  nodes,
  depth,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  depth: number;
  selected: string | null;
  onSelect: (node: TreeNode) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggle(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  return (
    <>
      {nodes.map((node) => (
        <div key={node.path}>
          <div
            onClick={() => node.isDir ? toggle(node.path) : onSelect(node)}
            className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer text-xs transition-colors rounded ${
              selected === node.path ? "bg-surface-hover text-white" : "text-muted hover:text-white hover:bg-surface-hover/50"
            }`}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
          >
            {node.isDir ? (
              <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d={collapsed.has(node.path) ? "M9 5l7 7-7 7" : "M19 9l-7 7-7-7"} />
              </svg>
            ) : (
              <span className={`text-[10px] font-mono font-bold w-3 text-center shrink-0 ${statusBadge[node.status || ""] || "text-muted"}`}>
                {node.status || "?"}
              </span>
            )}
            <span className="truncate">{node.name}</span>
          </div>
          {node.isDir && !collapsed.has(node.path) && (
            <FileTree nodes={node.children} depth={depth + 1} selected={selected} onSelect={onSelect} />
          )}
        </div>
      ))}
    </>
  );
}

export default function BranchMerge() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchJSON<Branch[]>("/api/branches").then(setBranches).catch(console.error);
  }, []);

  async function loadDiff() {
    if (!source || !target) return;
    setLoading(true);
    setSelectedFile(null);
    try {
      const d = await fetchJSON<FileDiff[]>(`/api/branches/diff?source=${source}&target=${target}`);
      setDiffs(d);
    } finally {
      setLoading(false);
    }
  }

  async function applyFile(path: string) {
    await fetchJSON("/api/branches/apply", {
      method: "POST",
      body: JSON.stringify({ source, file_path: path }),
    });
    setDiffs((prev) => prev.filter((d) => d.path !== path));
    setSelectedFile(null);
  }

  const tree = buildTree(diffs);

  return (
    <div className="flex flex-col h-full">
      {/* Branch selects */}
      <div className="shrink-0 p-3 border-b border-border">
        <div className="flex flex-col gap-2">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-tesla-red"
          >
            <option value="">Source branch...</option>
            {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-tesla-red"
          >
            <option value="">Target branch...</option>
            {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
          <button
            onClick={loadDiff}
            disabled={!source || !target || loading}
            className="bg-tesla-red hover:bg-tesla-red-hover disabled:opacity-30 text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
          >
            {loading ? "Loading..." : "Compare"}
          </button>
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 flex overflow-hidden">
        {diffs.length > 0 ? (
          <>
            {/* File tree */}
            <div className="w-1/2 border-r border-border overflow-auto py-1">
              <FileTree nodes={tree} depth={0} selected={selectedFile?.path || null} onSelect={setSelectedFile} />
              <div className="px-3 py-2 text-[10px] text-muted/50">{diffs.length} files changed</div>
            </div>

            {/* Diff viewer */}
            <div className="w-1/2 overflow-auto">
              {selectedFile && !selectedFile.isDir ? (
                <div>
                  <div className="sticky top-0 bg-bg/90 backdrop-blur-sm border-b border-border px-3 py-2 flex items-center justify-between">
                    <span className="font-mono text-xs text-white truncate">{selectedFile.path}</span>
                    <button
                      onClick={() => applyFile(selectedFile.path)}
                      className="shrink-0 text-[10px] bg-tesla-red/10 text-tesla-red hover:bg-tesla-red/20 px-2 py-0.5 rounded transition-colors"
                    >
                      Apply
                    </button>
                  </div>
                  <DiffViewer diff={selectedFile.diff || ""} path="" />
                </div>
              ) : (
                <div className="text-center text-muted py-12 text-xs">Select a file to view diff</div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 text-center text-muted py-12 text-xs">
            {source && target ? "No differences found" : "Select branches to compare"}
          </div>
        )}
      </div>
    </div>
  );
}
