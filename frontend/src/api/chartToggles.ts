/** 시나리오 '차트에 표시' 토글 — 클라이언트 상태 (최대 3개, D19) */
export const chartToggles = {
  get(): number[] {
    try {
      return JSON.parse(localStorage.getItem("moneymap.chart_scenarios") ?? "[]");
    } catch {
      return [];
    }
  },
  set(ids: number[]) {
    localStorage.setItem("moneymap.chart_scenarios", JSON.stringify(ids.slice(0, 3)));
  },
};
