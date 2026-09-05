import { req } from "./core";
import type { StatusSummary } from "./types";

export const statusApi = {
  health: () => req<{ status: string }>("/health"),
  status: () => req<StatusSummary>("/status"),

};
