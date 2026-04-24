import { useState, useCallback, useRef } from "react";
import Chat from "./pages/Chat";
import Dashboard from "./pages/Dashboard";
import Pipeline from "./pages/Pipeline";
import BranchMerge from "./pages/BranchMerge";
import DataBrowser from "./pages/DataBrowser";
import ToastContainer from "./components/ToastContainer";

function useResize(
  key: string,
  direction: "horizontal" | "vertical",
  initial: number,
  min: number,
  max: number,
  invert = false,
) {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(`layout:${key}`);
    return saved ? Number(saved) : initial;
  });
  const dragging = useRef(false);
  const startPos = useRef(0);
  const startVal = useRef(0);
  const latestVal = useRef(value);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startPos.current = direction === "horizontal" ? e.clientX : e.clientY;
      startVal.current = value;

      const onMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
        const total = direction === "horizontal" ? window.innerWidth : window.innerHeight;
        const delta = ((pos - startPos.current) / total) * 100;
        const next = Math.min(max, Math.max(min, startVal.current + (invert ? -delta : delta)));
        latestVal.current = next;
        setValue(next);
      };

      const onUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        localStorage.setItem(`layout:${key}`, String(latestVal.current));
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [direction, value, min, max],
  );

  return { value, onMouseDown };
}

function PanelHeader({ label, icon }: { label: string; icon: string }) {
  return (
    <div className="shrink-0 bg-surface border-b border-border px-4 py-2.5 flex items-center gap-2">
      <svg className="w-4 h-4 text-tesla-red" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d={icon} />
      </svg>
      <span className="text-sm font-semibold text-white tracking-tight">{label}</span>
    </div>
  );
}

function VDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="shrink-0 h-1 bg-border hover:bg-tesla-red cursor-row-resize transition-colors"
    />
  );
}

function HDivider({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className="shrink-0 w-1 bg-border hover:bg-tesla-red cursor-col-resize transition-colors"
    />
  );
}

export default function App() {
  const colLeft = useResize("colLeft", "horizontal", 22, 10, 40);
  const colRight = useResize("colRight", "horizontal", 22, 10, 40, true);
  const splitLeft = useResize("splitLeft", "vertical", 50, 15, 85);
  const splitRight = useResize("splitRight", "vertical", 50, 15, 85);

  return (
    <>
    <ToastContainer />
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Left column: Experiments (top) + Pipeline (bottom) */}
      <div className="flex flex-col border-r border-border overflow-hidden" style={{ width: `${colLeft.value}%` }}>
        <div className="flex flex-col overflow-hidden" style={{ height: `${splitLeft.value}%` }}>
          <PanelHeader label="Experiments" icon="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714a2.25 2.25 0 00.659 1.591L19 14.5M14.25 3.104c.251.023.501.05.75.082M19 14.5l-2.47 2.47a2.25 2.25 0 01-1.591.659H9.061a2.25 2.25 0 01-1.591-.659L5 14.5m14 0V17a2 2 0 01-2 2H7a2 2 0 01-2-2v-2.5" />
          <div className="flex-1 overflow-auto">
            <Dashboard />
          </div>
        </div>
        <VDivider onMouseDown={splitLeft.onMouseDown} />
        <div className="flex flex-col flex-1 overflow-hidden">
          <PanelHeader label="Pipeline" icon="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          <div className="flex-1 overflow-auto">
            <Pipeline />
          </div>
        </div>
      </div>

      <HDivider onMouseDown={colLeft.onMouseDown} />

      {/* Middle column: Chat */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <Chat />
      </div>

      <HDivider onMouseDown={colRight.onMouseDown} />

      {/* Right column: Branches (top) + Data (bottom) */}
      <div className="flex flex-col border-l border-border overflow-hidden" style={{ width: `${colRight.value}%` }}>
        <div className="flex flex-col overflow-hidden" style={{ height: `${splitRight.value}%` }}>
          <PanelHeader label="Branches" icon="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          <div className="flex-1 overflow-auto">
            <BranchMerge />
          </div>
        </div>
        <VDivider onMouseDown={splitRight.onMouseDown} />
        <div className="flex flex-col flex-1 overflow-hidden">
          <PanelHeader label="Data" icon="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 3.75c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
          <div className="flex-1 overflow-auto">
            <DataBrowser />
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
