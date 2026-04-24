export default function DiffViewer({ diff, path }: { diff: string; path: string }) {
  const lines = diff.split("\n");
  return (
    <div>
      {path && <div className="px-4 py-2 text-xs font-mono text-muted border-b border-border">{path}</div>}
      <pre className="p-4 overflow-auto max-h-96 text-xs font-mono leading-relaxed m-0">
        {lines.map((line, i) => {
          let cls = "text-gray-400";
          if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-400 bg-green-500/5";
          if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-400 bg-red-500/5";
          if (line.startsWith("@@")) cls = "text-blue-400";
          return (
            <div key={i} className={cls}>{line || " "}</div>
          );
        })}
      </pre>
    </div>
  );
}
