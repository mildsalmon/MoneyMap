import { todayIso } from "../format";

export interface HistoryCriteria { start: string; end: string; tag: string; accountId?: string; accountScope?: "direct" | "subtree" }
export interface HistoryQuery extends HistoryCriteria { page: number }
export type HistoryPreset = "recent" | "this-month" | "last-month";

export function validHistoryDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && localDate(date) === value;
}
function localDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function historyPreset(preset: HistoryPreset, today = todayIso()): HistoryCriteria {
  const end = new Date(`${today}T12:00:00`), start = new Date(end);
  start.setDate(1);
  if (preset === "this-month") end.setMonth(end.getMonth() + 1, 0);
  else if (preset === "last-month") { end.setDate(0); start.setMonth(start.getMonth() - 1); }
  else {
    start.setMonth(start.getMonth() - 1);
    const last = new Date(end); last.setDate(0);
    start.setDate(Math.min(end.getDate(), last.getDate()) + 1);
  }
  return { start: localDate(start), end: localDate(end), tag: "" };
}
export function historyCriteriaError(value: HistoryCriteria): string | undefined {
  if (!validHistoryDate(value.start) || !validHistoryDate(value.end)) return "올바른 시작일과 종료일을 입력하세요.";
  if (value.accountId !== undefined && (!/^[1-9]\d*$/.test(value.accountId) || !Number.isSafeInteger(Number(value.accountId)))) return "올바른 계정과목을 선택하세요.";
  if (value.accountScope !== undefined && (!value.accountId || !["direct", "subtree"].includes(value.accountScope))) return "올바른 하위 계정 조회 조건을 선택하세요.";
  if (value.start > value.end) return "종료일은 시작일과 같거나 이후여야 합니다.";
}
export function readHistoryQuery(params: URLSearchParams, today = todayIso()): { draft: HistoryCriteria; query?: HistoryQuery; error?: string } {
  const defaults = historyPreset("recent", today);
  const missingDates = !params.has("start") && !params.has("end");
  const draft = { start: missingDates ? defaults.start : params.get("start") ?? "",
    end: missingDates ? defaults.end : params.get("end") ?? "", tag: params.get("tag") ?? "",
    ...(params.has("account_id") ? { accountId: params.get("account_id")! } : {}),
    ...(params.has("include_descendants") || params.has("account_id") ? {
      accountScope: params.get("include_descendants") === "false" ? "direct" as const : "subtree" as const } : {}) };
  const rawPage = params.get("page") ?? "1", page = Number(rawPage);
  const badAccountParams = ["account_id", "include_descendants"].some(key => params.getAll(key).length > 1)
    || (params.has("include_descendants") && (!params.has("account_id") || !["true", "false"].includes(params.get("include_descendants")!)));
  const error = (badAccountParams ? "계정 조회 조건을 올바르게 지정하세요." : undefined) ?? historyCriteriaError(draft)
    ?? (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(page) ? "올바른 페이지 번호를 입력하세요." : undefined);
  return { draft, query: error ? undefined : { ...draft, page }, error };
}
export function historySearch(query: HistoryQuery): string {
  const params = new URLSearchParams({ start: query.start, end: query.end });
  if (query.tag) params.set("tag", query.tag);
  if (query.accountId) {
    params.set("account_id", query.accountId);
    params.set("include_descendants", String(query.accountScope !== "direct"));
  }
  params.set("page", String(query.page));
  return `?${params}`;
}
export function criteriaKey(value: HistoryCriteria): string { return JSON.stringify([value.start, value.end, value.tag, value.accountId ?? null, value.accountScope ?? "subtree"]); }
export function historyKey(value: HistoryQuery): string { return JSON.stringify([value.start, value.end, value.tag, value.page, value.accountId ?? null, value.accountScope ?? "subtree"]); }
