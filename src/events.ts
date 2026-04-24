import { EventEmitter } from "events";

export interface AppNotification {
  title: string;
  body: string;
  level: "info" | "success" | "error";
}

export const eventBus = new EventEmitter();

export function notify(title: string, body: string, level: AppNotification["level"] = "info") {
  eventBus.emit("notification", { title, body, level } satisfies AppNotification);
}
