// 숫자 포맷 규칙 (DESIGN.md · D15)
// 전체 금액: ₩42,180,000 (₩ 뒤 공백 없음) · 축약: 4,218만 / 5.1억 ("M" 금지)

export function fmtWon(n: number | bigint): string {
  const sign = n < 0 ? "−" : "";
  const magnitude = typeof n === "bigint" ? (n < 0n ? -n : n) : Math.abs(n);
  return `${sign}₩${magnitude.toLocaleString("ko-KR")}`;
}

/** Native minor units; keep KRW's established ledger typography. */
export function fmtMoney(n: number | bigint, currency: string): string {
  if (currency === "KRW") return fmtWon(n);
  const minor = BigInt(n), magnitude = minor < 0n ? -minor : minor;
  const formatter = new Intl.NumberFormat("ko-KR", { style: "currency", currency });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  const scale = 10n ** BigInt(digits);
  const parts = formatter.formatToParts(magnitude / scale);
  return (minor < 0n ? "−" : "") + parts.map(part => part.type === "fraction"
    ? String(magnitude % scale).padStart(digits, "0") : part.value).join("");
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

export function fmtDelta(n: number | bigint): string {
  return `${n >= 0 ? "+" : ""}${fmtWon(n)}`;
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
