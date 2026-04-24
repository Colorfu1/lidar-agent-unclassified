import { useEffect, useCallback } from "react";
import { addToast } from "../components/ToastContainer";

export function useNotifications() {
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  return useCallback((title: string, body: string, level?: "info" | "success" | "error") => {
    addToast(title, body, level);
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  }, []);
}
