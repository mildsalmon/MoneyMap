function validStatisticsDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export interface StatisticsPeriod { start: string; end: string }
export type StatisticsPreset = "this-month" | "last-month" | "this-year" | "recent-year";
export function statisticsToday(): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function statisticsPreset(preset: StatisticsPreset, today = statisticsToday()): StatisticsPeriod {
  const [y, m] = today.split("-").map(Number);
  if (preset === "this-year") return { start: `${y}-01-01`, end: today };
  if (preset === "this-month") return { start: `${today.slice(0, 7)}-01`, end: today };
  if (preset === "recent-year") {
    const year = m === 12 ? y : y - 1, month = m === 12 ? 1 : m + 1;
    return { start: `${year}-${String(month).padStart(2, "0")}-01`, end: today };
  }
  const last = new Date(Date.UTC(y, m - 1, 0, 12));
  const month = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start: `${month}-01`, end: `${month}-${last.getUTCDate()}` };
}
export function statisticsPeriodError(period: StatisticsPeriod, today = statisticsToday()): string | undefined {
  if (!validStatisticsDate(period.start) || !validStatisticsDate(period.end)) return "올바른 시작일과 종료일을 입력하세요.";
  if (period.start > period.end) return "종료일은 시작일과 같거나 이후여야 합니다.";
  if (period.end > today) return `종료일은 서울 기준 오늘(${today})까지 지정하세요.`;
  const days = (Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > 3660) return "최대 3660일 범위로 조회하세요.";
}
export function statisticsSearch(period: StatisticsPeriod): string {
  return `?${new URLSearchParams({ start: period.start, end: period.end })}`;
}
export function readStatisticsPeriod(search: string) {
  const params = new URLSearchParams(search);
  const missing = !params.has("start") && !params.has("end");
  const draft = missing ? statisticsPreset("this-year") : { start: params.get("start") ?? "", end: params.get("end") ?? "" };
  const error = statisticsPeriodError(draft)
    ?? ([...params.keys()].some(key => !["start", "end"].includes(key)) || ["start", "end"].some(key => params.getAll(key).length > 1)
      ? "시작일과 종료일을 하나씩 지정하세요." : undefined);
  return { draft, error, query: error ? undefined : draft };
}
