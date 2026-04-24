import { useState, useEffect, useCallback } from "react";

interface Toast {
  id: number;
  title: string;
  body: string;
  level: "info" | "success" | "error";
}

const BORDER_COLOR: Record<Toast["level"], string> = {
  info: "border-blue-500",
  success: "border-green-500",
  error: "border-red-500",
};

let nextId = 0;
let externalAdd: ((title: string, body: string, level?: Toast["level"]) => void) | null = null;

export function addToast(title: string, body: string, level: Toast["level"] = "info") {
  externalAdd?.(title, body, level);
}

export default function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const add = useCallback((title: string, body: string, level: Toast["level"] = "info") => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, title, body, level }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    externalAdd = add;
    return () => { externalAdd = null; };
  }, [add]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`bg-surface border-l-4 ${BORDER_COLOR[t.level]} rounded shadow-lg px-4 py-3 animate-[slideIn_0.2s_ease-out]`}
        >
          <div className="text-sm font-semibold text-white">{t.title}</div>
          <div className="text-xs text-gray-400 mt-0.5">{t.body}</div>
        </div>
      ))}
    </div>
  );
}
