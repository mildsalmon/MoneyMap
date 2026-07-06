// 숫자 포맷 규칙 (DESIGN.md · D15)
// 전체 금액: ₩42,180,000 (₩ 뒤 공백 없음) · 축약: 4,218만 / 5.1억 ("M" 금지)

export function fmtWon(n: number): string {
  const sign = n < 0 ? "−" : "";
  return `${sign}₩${Math.abs(n).toLocaleString("ko-KR")}`;
}

export function fmtAbbrev(n: number): string {
  const sign = n < 0 ? "−" : "";
  const abs = Math.abs(n);
  if (abs >= 100_000_000) {
    const eok = abs / 100_000_000;
    return `${sign}${eok >= 10 ? Math.round(eok).toLocaleString("ko-KR") : eok.toFixed(1)}억`;
  }
  if (abs >= 10_000) return `${sign}${Math.round(abs / 10_000).toLocaleString("ko-KR")}만`;
  return `${sign}${abs.toLocaleString("ko-KR")}`;
}

export function fmtDelta(n: number): string {
  return `${n >= 0 ? "+" : "−"}₩${Math.abs(n).toLocaleString("ko-KR")}`;
}

/** 로컬(KST) 기준 오늘 — toISOString은 UTC라 저녁에 하루 밀린다 */
export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 금액 입력 필드용: 숫자만 남기고 콤마 삽입 (D12 자동 콤마) */
export function commaInput(raw: string): { display: string; value: number } {
  const digits = raw.replace(/[^\d]/g, "");
  const value = digits ? parseInt(digits, 10) : 0;
  return { display: value ? value.toLocaleString("ko-KR") : "", value };
}
