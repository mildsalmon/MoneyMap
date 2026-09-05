import { MonthlyChart } from "./MonthlyChart";
import { useState } from "react";
import { api, type Scenario, type Series, type CashShortage } from "../../api";
import { ProjectionChart } from "../../chart/ProjectionChart";
import { fmtDelta, fmtWon } from "../../format";
import { useQuery } from "./useQuery";
import { Link } from "react-router-dom";

export function ScenarioOverview({
  scenario,
  gen,
}: {
  scenario: Scenario;
  gen: number;
}) {
  const [metric, setMetric] = useState<"net_worth" | "cash">("net_worth");
  const [months, setMonths] = useState(6);
  const query = useQuery(
    `projection:${scenario.id}:${scenario.version}:${months}:${gen}`,
    (signal) => api.scenarioProjection(scenario.id, months, signal),
  );
  const data = query.data;
  const cashMode = metric === "cash" && (!data || data.capabilities?.scenario_liquidity === true);
  const selected = cashMode ? (data?.cash?.available ? data.cash : undefined) : data?.net_worth;
  const label = cashMode ? "현금성 잔액" : "순자산";
  const series: Series[] = data && selected
    ? (["baseline", "scenario"] as const)
        .filter((key) => key === "baseline" || data.has_assumptions)
        .map((key) => ({
          id: key === "baseline" ? "baseline" : scenario.id,
          name: key === "baseline" ? "현재 패턴 유지" : scenario.name,
          kind: key,
          points: selected[key].points.map((p) => ({
            date: p.date,
            net_worth: p.balance,
          })),
        }))
    : [];
  const last = (key: "baseline" | "scenario") =>
    selected![key].points.at(-1)!.balance;
  return (
    <div>
      <div className="scenario-controls">
        <h2>{label} 전망</h2>
        {data?.capabilities?.scenario_liquidity === true && (
          <div role="group" aria-label="전망 지표">
            {(["net_worth", "cash"] as const).map((key) => (
              <button key={key} className="btn secondary" aria-pressed={metric === key}
                onClick={() => setMetric(key)}>{key === "cash" ? "현금성 잔액" : "순자산"}</button>
            ))}
          </div>
        )}
        <div role="group" aria-label="전망 기간">
          {[3, 6, 12].map((m) => (
            <button
              key={m}
              className="btn secondary"
              aria-pressed={months === m}
              onClick={() => setMonths(m)}
            >
              {m}개월
            </button>
          ))}
        </div>
      </div>
      {query.error ? (
        <p role="alert">
          {query.error}{" "}
          <button className="btn" onClick={query.reload}>
            다시 계산
          </button>
        </p>
      ) : !data ? (
        <p role="status">전망 계산 중…</p>
      ) : (
        <>
          {cashMode && !selected ? (
            <p>현금 부족 계산에 포함할 계정을 먼저 선택하세요 <Link to="/accounts">계정 설정</Link></p>
          ) : selected && <>
          <dl className="scenario-summary">
            <div>
              <dt>시작 {label}</dt>
              <dd>{fmtWon(selected.scenario.points[0].balance)}</dd>
            </div>
            <div>
              <dt>{months}개월 뒤 예상</dt>
              <dd>{fmtWon(last("scenario"))}</dd>
            </div>
            <div>
              <dt>현재 패턴 유지와 차이</dt>
              <dd>{fmtDelta(last("scenario") - last("baseline"))}</dd>
            </div>
          </dl>
          {!data.has_assumptions && (
            <p>
              아직 시나리오 전용 가정이 없습니다. 두 전망은 같습니다.{" "}
              {scenario.status === "active" && (
                <Link to={`/scenarios/${scenario.id}/assumptions`}>
                  가정 추가
                </Link>
              )}
            </p>
          )}
          <ProjectionChart
            series={series}
            today={data.fork_date}
            anchorLabel="시작 기준일"
            metricLabel={label}
          />
          {cashMode && data.cash?.available && (
            <div className="scenario-shortages">
              <Shortage name="현재 패턴 유지" value={data.cash.baseline.shortage} />
              <Shortage name={scenario.name} value={data.cash.scenario.shortage} />
            </div>
          )}
          </>}
          <h2>월별 수입·지출</h2>
          <MonthlyChart rows={data.monthly_income_expense} />
          <div className="table-scroll">
            <table className="ledger">
              <caption>
                수익·비용 계정 기준. 이체는 제외하며 환불은 음수로 반영합니다.
              </caption>
              <thead>
                <tr>
                  <th>월</th>
                  <th className="num">기준 수입</th>
                  <th className="num">시나리오 수입</th>
                  <th className="num">기준 지출</th>
                  <th className="num">시나리오 지출</th>
                </tr>
              </thead>
              <tbody>
                {data.monthly_income_expense.map((row) => (
                  <tr key={row.month}>
                    <th scope="row">{row.month}</th>
                    {[
                      row.baseline.income,
                      row.scenario.income,
                      row.baseline.expense,
                      row.scenario.expense,
                    ].map((value, i) => (
                      <td className="num" key={i}>
                        {fmtWon(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>계산 근거</summary>
            <p>
              {data.fork_date} 실제 장부 마감 잔액에서 시작해{" "}
              {data.projection_start}부터 {data.projection_end}까지 등록한
              규칙과 예정 거래만 계산합니다. 실제 규칙 변경은 다음 조회에
              반영되며 최근 지출 평균은 추정하지 않습니다.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

function Shortage({ name, value }: { name: string; value: CashShortage | null }) {
  return <section aria-label={`${name} 현금 부족`}>
    <h3>{name} · 현금 부족</h3>
    {!value ? <p>이 기간에는 일 마감 현금 부족이 없습니다.</p> : <>
      <p>첫 부족: {value.first_shortage.start} ~ {value.first_shortage.end ?? "전망 종료일까지 지속"}
        {" "}({value.first_shortage.days}일)</p>
      <p className="shortage-maximum"><span>최대 부족: </span><span className="num">{fmtWon(Math.abs(value.maximum_shortage.balance))}</span><span> · {value.maximum_shortage.date}</span></p>
      {value.first_shortage.reason === "negative_start_balance" ? <p>시작 기준일 잔액이 이미 음수입니다.</p> : <>
        <p>첫 부족일의 항목</p>
        <ul>{value.first_shortage.triggering_items.map((item) => <li key={`${item.kind}-${item.id}`}>
          {item.label || (item.kind === "rule" ? "반복 규칙" : "예정 거래")}
        </li>)}</ul>
      </>}
    </>}
  </section>;
}
