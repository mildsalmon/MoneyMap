/**
 * 순자산 프로젝션 차트 — dataviz 스킬 스펙 준수.
 *
 * - step-after 보간: 순자산은 이벤트 사이에서 상수 (fold 의미론과 일치 —
 *   "한 치도 안 틀리는" 선은 부드러운 곡선이 아니라 계단이다)
 * - 선 2px(실제 2.5px), 엔드 마커 r4 + 서피스 링 2px, 헤어라인 그리드(실선)
 * - 크로스헤어가 X를 찾고, 툴팁은 그 X의 모든 시리즈 값을 나열
 * - 키보드: ←/→로 크로스헤어 이동 (호버와 동일 정보)
 * - 표 뷰 토글 — 툴팁이 게이트하지 않는다
 * - 색은 검증된 팔레트 + 선 스타일 병행 (색 단독 식별 금지)
 */
import { useMemo, useRef, useState } from "react";
import type { Series } from "../api";
import { fmtAbbrev, fmtDelta, fmtWon } from "../format";

const W = 920;
const H = 280;
const PAD = { top: 14, right: 150, bottom: 26, left: 56 };

const STYLE: Record<string, { color: string; width: number; dash?: string }> = {
  actual: { color: "var(--chart-actual)", width: 2.5 },
  baseline: { color: "var(--chart-baseline)", width: 2 },
  s0: { color: "var(--chart-s1)", width: 2, dash: "7 4" },
  s1: { color: "var(--chart-s2)", width: 2, dash: "4 3" },
  s2: { color: "var(--chart-s3)", width: 2, dash: "2 3" },
};

function styleOf(s: Series, scenarioIndex: number) {
  if (s.kind === "actual") return STYLE.actual;
  if (s.kind === "baseline") return STYLE.baseline;
  return STYLE[`s${scenarioIndex}`] ?? STYLE.s0;
}

const localDate = (value: number) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

const day = (iso: string) => new Date(iso + "T00:00:00").getTime();

/** step 의미론: x 시점의 값 = date ≤ x 인 마지막 점.
 *  단, '실제' 시리즈는 마지막 데이터(오늘) 이후로 값을 보고하지 않는다 —
 *  선이 오늘에서 끊기는 규칙(D17)은 툴팁·표에도 똑같이 적용된다. */
function valueAt(s: Series, x: number): number | null {
  if (s.points.length === 0) return null;
  if (s.kind === "actual" && x > day(s.points[s.points.length - 1].date)) return null;
  let v: number | null = null;
  for (const p of s.points) {
    if (day(p.date) > x) break;
    v = p.net_worth;
  }
  return v;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) [min, max] = [min - 1, max + 1];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max; v += step) out.push(v);
  return out;
}

export function ProjectionChart({
  series,
  today,
  anchorLabel = "오늘",
  metricLabel = "순자산",
}: {
  series: Series[];
  today: string;
  anchorLabel?: string;
  metricLabel?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hoverX, setHoverX] = useState<number | null>(null); // 스냅된 날짜(ms)
  const [showTable, setShowTable] = useState(false);

  const scenarios = series.filter((s) => s.kind === "scenario");
  const withStyle = series.map((s) => ({
    s,
    st: styleOf(s, scenarios.indexOf(s)),
  }));

  const { xMin, xMax, yTicks, sx, sy, allDates } = useMemo(() => {
    const pts = series.flatMap((s) => s.points);
    const xs = pts.map((p) => day(p.date));
    const ys = pts.map((p) => p.net_worth);
    const xMin = Math.min(...xs, day(today));
    const xMax = Math.max(...xs, day(today));
    const yMin = Math.min(...ys, 0 === ys.length ? 0 : ys[0]);
    const yMax = Math.max(...ys);
    const ticks = niceTicks(yMin, yMax);
    const lo = Math.min(yMin, ticks[0] ?? yMin);
    const hi = Math.max(yMax, ticks[ticks.length - 1] ?? yMax);
    const sx = (x: number) =>
      PAD.left + ((x - xMin) / Math.max(1, xMax - xMin)) * (W - PAD.left - PAD.right);
    const sy = (y: number) =>
      H - PAD.bottom - ((y - lo) / Math.max(1, hi - lo)) * (H - PAD.top - PAD.bottom);
    const allDates = [...new Set(xs)].sort((a, b) => a - b);
    return { xMin, xMax, yTicks: ticks, sx, sy, allDates };
  }, [series, today]);

  if (series.every((s) => s.points.length === 0)) return null;

  const stepPath = (s: Series) => {
    let d = "";
    let prevY: number | null = null;
    for (const p of s.points) {
      const x = sx(day(p.date));
      const y = sy(p.net_worth);
      if (d === "") d = `M${x},${y}`;
      else d += ` H${x} V${y}`;
      prevY = y;
    }
    void prevY;
    // 시리즈 마지막 점 이후 구간은 그리지 않음 (실제 선이 오늘에서 끊기는 규칙, D17)
    return d;
  };

  // 직접 엔드 라벨 — y로 정렬 후 최소 15px 간격으로 밀어내기 (겹침 방지)
  const endLabels = useMemo(() => {
    const raw = withStyle
      .filter(({ s }) => s.points.length > 0)
      .map(({ s, st }) => {
        const last = s.points[s.points.length - 1];
        return { name: s.name, color: st.color, x: sx(day(last.date)), y: sy(last.net_worth), v: last.net_worth };
      })
      .sort((a, b) => a.y - b.y);
    for (let i = 1; i < raw.length; i++) {
      if (raw[i].y - raw[i - 1].y < 15) raw[i].y = raw[i - 1].y + 15;
    }
    return raw;
  }, [withStyle, sx, sy]);

  const snap = (clientX: number) => {
    const rect = wrapRef.current!.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * W;
    const t = xMin + ((px - PAD.left) / (W - PAD.left - PAD.right)) * (xMax - xMin);
    let best = allDates[0];
    for (const d of allDates) if (Math.abs(d - t) < Math.abs(best - t)) best = d;
    setHoverX(best);
  };

  const moveIndex = (dir: 1 | -1) => {
    const i = hoverX === null ? (dir === 1 ? 0 : allDates.length - 1)
      : Math.min(allDates.length - 1, Math.max(0, allDates.indexOf(hoverX) + dir));
    setHoverX(allDates[i]);
  };

  const baseline = series.find((s) => s.kind === "baseline");
  const hoverBaseVal = hoverX !== null && baseline ? valueAt(baseline, hoverX) : null;
  const tipLeftPct = hoverX !== null ? (sx(hoverX) / W) * 100 : 0;

  return (
    <div>
      {/* 범례 — 2개 이상 시리즈에는 항상 (dataviz 규칙) */}
      <div className="legend">
        {withStyle.map(({ s, st }) => (
          <span key={String(s.id)}>
            <span
              className="key"
              style={{ borderColor: st.color, borderTopStyle: st.dash ? "dashed" : "solid" }}
            />
            {s.name}
          </span>
        ))}
        <button className="viewtoggle" style={{ marginLeft: "auto" }} onClick={() => setShowTable(!showTable)}>
          {showTable ? "차트로 보기" : "표로 보기"}
        </button>
      </div>

      <div
        ref={wrapRef}
        className="chart-wrap"
        tabIndex={0}
        role="img"
        aria-label={`${metricLabel} 프로젝션 차트. 화살표 키로 날짜를 탐색하세요.`}
        onPointerMove={(e) => snap(e.clientX)}
        onPointerLeave={() => setHoverX(null)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") { e.preventDefault(); moveIndex(1); }
          if (e.key === "ArrowLeft") { e.preventDefault(); moveIndex(-1); }
          if (e.key === "Escape") setHoverX(null);
        }}
      >
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
          {/* 그리드 — 헤어라인 실선, recessive */}
          {yTicks
            .filter((t) => sy(t) > PAD.top + 6 && sy(t) < H - PAD.bottom - 6) // 경계 잘림 방지
            .map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke="var(--line)" strokeWidth="1" />
                <text x={PAD.left - 8} y={sy(t) + 4} fontSize="11" textAnchor="end" fill="var(--muted)"
                  style={{ fontVariantNumeric: "tabular-nums" }}>
                  {fmtAbbrev(t)}
                </text>
              </g>
            ))}
          {/* 오늘 마커 */}
          <line x1={sx(day(today))} x2={sx(day(today))} y1={PAD.top} y2={H - PAD.bottom}
            stroke="var(--faint)" strokeWidth="1" />
          <text x={sx(day(today))} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--muted)">{anchorLabel}</text>

          {/* 시리즈 (step-after) */}
          {withStyle.map(({ s, st }) =>
            s.points.length > 0 ? (
              <path key={String(s.id)} d={stepPath(s)} fill="none" stroke={st.color}
                strokeWidth={st.width} strokeDasharray={st.dash} strokeLinejoin="round" strokeLinecap="round" />
            ) : null,
          )}

          {/* 엔드 마커 — r4 + 서피스 링 2px */}
          {withStyle.map(({ s, st }) => {
            if (s.points.length === 0) return null;
            const last = s.points[s.points.length - 1];
            return (
              <circle key={`m-${String(s.id)}`} cx={sx(day(last.date))} cy={sy(last.net_worth)} r="4"
                fill={st.color} stroke="var(--bg)" strokeWidth="2" />
            );
          })}

          {/* 직접 엔드 라벨 — 텍스트는 텍스트 토큰, 색 점이 정체성 운반 */}
          {endLabels.map((l) => (
            <g key={l.name}>
              {/* 리더선은 우측 짧은 스텁만 — 왼쪽에서 끝나는 시리즈(실제)가
                  차트 전체를 가로지르는 선을 만들지 않게 한다 */}
              <line x1={Math.max(l.x + 6, W - PAD.right - 30)} x2={W - PAD.right + 10}
                y1={l.y} y2={l.y} stroke="var(--line)" strokeWidth="1" />
              <circle cx={W - PAD.right + 14} cy={l.y} r="3.5" fill={l.color} />
              <text x={W - PAD.right + 22} y={l.y + 3.5} fontSize="11" fill="var(--muted)">{l.name}</text>
            </g>
          ))}

          {/* 크로스헤어 */}
          {hoverX !== null && (
            <g>
              <line x1={sx(hoverX)} x2={sx(hoverX)} y1={PAD.top} y2={H - PAD.bottom}
                stroke="var(--line-strong)" strokeWidth="1" />
              {withStyle.map(({ s, st }) => {
                const v = valueAt(s, hoverX);
                return v === null ? null : (
                  <circle key={`h-${String(s.id)}`} cx={sx(hoverX)} cy={sy(v)} r="4.5"
                    fill={st.color} stroke="var(--bg)" strokeWidth="2" />
                );
              })}
            </g>
          )}
        </svg>

        {/* 툴팁 — 값이 주연, 이름이 조연. 모든 시리즈를 한 번에 (dataviz 규칙) */}
        {hoverX !== null && (
          <div className="chart-tip" style={{
            left: `min(max(${tipLeftPct}%, 12%), 74%)`,
            top: 8,
            transform: "translateX(-50%)",
          }}>
            <div className="date">{localDate(hoverX)}</div>
            {withStyle.map(({ s, st }) => {
              const v = valueAt(s, hoverX);
              if (v === null) return null;
              const delta = s.kind === "scenario" && hoverBaseVal !== null ? v - hoverBaseVal : null;
              return (
                <div className="row" key={String(s.id)}>
                  <span className="k" style={{ borderColor: st.color, borderTopStyle: st.dash ? "dashed" : "solid" }} />
                  <span className="name">{s.name}</span>
                  <span>
                    <span className="val">{fmtWon(v)}</span>
                    {delta !== null && delta !== 0 && (
                      <span className="sub"> ({fmtDelta(delta)} 기준 대비)</span>
                    )}
                  </span>
                </div>
              );
            })}
            {baseline?.basis && (
              <div className="basis">
                기준선 근거: 반복 규칙 + 변동지출 월평균 {fmtWon(baseline.basis.monthly_variable_spend)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 표 뷰 — 접근성 필수 경로 */}
      {showTable && (
        <table className="ledger" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>날짜</th>
              {series.map((s) => (
                <th key={String(s.id)} className="num">{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {allDates.map((d) => (
              <tr key={d}>
                <td>{localDate(d)}</td>
                {series.map((s) => {
                  const v = valueAt(s, d);
                  return (
                    <td key={String(s.id)} className="num">
                      {v === null ? "—" : fmtWon(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
