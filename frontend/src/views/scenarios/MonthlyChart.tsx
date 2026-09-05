import type { Projection } from "../../api";
import { fmtAbbrev } from "../../format";

/** The adjacent table supplies exact values and the accessible alternative. */
export function MonthlyChart({
  rows,
}: {
  rows: Projection["monthly_income_expense"];
}) {
  const values = rows.flatMap((row) => [
    row.baseline.income,
    row.scenario.income,
    row.baseline.expense,
    row.scenario.expense,
  ]);
  const maximum = Math.max(1, ...values);
  const minimum = Math.min(0, ...values);
  const height = 200;
  const width = Math.max(680, rows.length * 80 + 70);
  const y = (value: number) =>
    16 + ((maximum - value) / (maximum - minimum)) * 144;
  const zero = y(0);
  const groupWidth = (width - 70) / Math.max(1, rows.length);
  const colors = [
    "var(--chart-s1)",
    "var(--chart-s1)",
    "var(--chart-s2)",
    "var(--chart-s2)",
  ];
  return (
    <>
      <p className="muted">
        빈 막대는 기준, 채운 막대는 시나리오입니다. 각 월의 왼쪽 두 막대는 수입,
        오른쪽 두 막대는 지출입니다.
      </p>
      <div className="table-scroll">
        <svg
          aria-hidden="true"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ maxWidth: "none", display: "block" }}
        >
          {[maximum, 0, ...(minimum < 0 ? [minimum] : [])].map((value, i) => (
            <g key={i}>
              <line
                x1="60"
                x2={width}
                y1={y(value)}
                y2={y(value)}
                stroke="var(--line)"
              />
              <text
                x="52"
                y={y(value) + 4}
                textAnchor="end"
                fill="var(--muted)"
                fontSize="11"
              >
                {fmtAbbrev(value)}
              </text>
            </g>
          ))}
          {rows.map((row, index) => (
            <g key={row.month}>
              {[
                row.baseline.income,
                row.scenario.income,
                row.baseline.expense,
                row.scenario.expense,
              ].map((value, i) => (
                <rect
                  key={i}
                  x={65 + index * groupWidth + i * 13}
                  y={Math.min(zero, y(value))}
                  width="10"
                  height={Math.abs(y(value) - zero)}
                  fill={i % 2 ? colors[i] : "none"}
                  stroke={colors[i]}
                />
              ))}
              <text
                x={90 + index * groupWidth}
                y="186"
                textAnchor="middle"
                fill="var(--muted)"
                fontSize="11"
              >
                {row.month}
              </text>
            </g>
          ))}
        </svg>
      </div>
    </>
  );
}
