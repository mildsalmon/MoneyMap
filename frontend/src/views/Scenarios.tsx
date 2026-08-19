import { useEffect, useState } from "react";
import { api, chartToggles, type Account, type Rule, type Scenario } from "../api";
import { commaInput, fmtDelta, fmtWon, todayIso } from "../format";
import { humanSchedule, RuleForm } from "./Rules";
import type { ViewProps } from "../App";


function ScenarioEditor({
  scenario,
  accounts,
  onChanged,
  showToast,
}: {
  scenario: Scenario;
  accounts: Account[];
  onChanged: () => void;
  showToast: ViewProps["showToast"];
}) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [preview, setPreview] = useState<{ base: number; mine: number } | null>(null);
  const [editAmount, setEditAmount] = useState<Record<number, string>>({});
  const [deleteErrors, setDeleteErrors] = useState<Record<number, string>>({});
  const [localGen, setLocalGen] = useState(0);

  useEffect(() => {
    api.rules(scenario.id).then(setRules);
    // 즉시 미리보기: 1년 뒤 기준선 vs 이 시나리오
    api.projection(12, [scenario.id]).then(({ series }) => {
      const base = series.find((s) => s.kind === "baseline");
      const mine = series.find((s) => s.kind === "scenario");
      if (base?.points.length && mine?.points.length) {
        setPreview({
          base: base.points[base.points.length - 1].net_worth,
          mine: mine.points[mine.points.length - 1].net_worth,
        });
      }
    });
  }, [scenario.id, localGen]);

  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  const saveAmount = async (r: Rule) => {
    const { value } = commaInput(editAmount[r.id] ?? "");
    if (!value) return;
    await api.updateRule(r.id, {
      scenario_id: r.scenario_id,
      description: r.description,
      from_account_id: r.from_account_id,
      to_account_id: r.to_account_id,
      amount: value,
      schedule: r.schedule.spec,
      start_date: r.start_date,
      end_date: r.end_date,
    });
    setEditAmount((s) => ({ ...s, [r.id]: "" }));
    setLocalGen((g) => g + 1);
    onChanged();
    showToast(`"${r.description || nameOf(r.from_account_id)}" 규칙을 ${fmtWon(value)}로 수정`);
  };

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <h2 className="panel-heading">
        시나리오: {scenario.name} <span style={{ color: "var(--faint)", fontWeight: 400 }}>({scenario.fork_date}에 분기 · 규칙은 분기 시점에 복사됨)</span>
      </h2>
      <div className="table-scroll scenario-editor-scroll">
        <table className="ledger">
          <thead>
            <tr><th>규칙</th><th>흐름</th><th className="num">금액/회</th><th>일정</th><th className="num">수정</th><th /></tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id}>
              <td>{r.description || "—"}</td>
              <td style={{ color: "var(--muted)" }}>{nameOf(r.from_account_id)} → {nameOf(r.to_account_id)}</td>
              <td className="num">{fmtWon(r.amount.amount)}</td>
              <td>{humanSchedule(r.schedule.spec)}</td>
              <td className="num">
                <input className="num" aria-label={`${r.description || nameOf(r.from_account_id)} 금액 수정`}
                  placeholder={r.amount.amount.toLocaleString("ko-KR")}
                  style={{ width: 110, padding: "3px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
                  value={editAmount[r.id] ?? ""}
                  onChange={(e) => setEditAmount((s) => ({ ...s, [r.id]: commaInput(e.target.value).display }))}
                  onKeyDown={(e) => e.key === "Enter" && saveAmount(r)} />
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                <button className="btn sm secondary" disabled={!commaInput(editAmount[r.id] ?? "").value}
                  onClick={() => saveAmount(r)}>저장</button>{" "}
                <button className="btn sm danger" onClick={async () => {
                  if (!window.confirm(`이 시나리오에서 "${r.description || nameOf(r.from_account_id)}" 규칙을 삭제합니다.`)) return;
                  setDeleteErrors((current) => ({ ...current, [r.id]: "" }));
                  try {
                    await api.deleteRule(r.id);
                    setLocalGen((g) => g + 1);
                    onChanged();
                    showToast("가설 규칙 삭제됨");
                  } catch (error) {
                    setDeleteErrors((current) => ({ ...current, [r.id]: (error as Error).message }));
                  }
                }}>삭제</button>
                {deleteErrors[r.id] && (
                  <span className="row-error action-error" role="alert">{deleteErrors[r.id]}</span>
                )}
              </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ margin: "14px 0" }}>
        <RuleForm scenarioId={scenario.id} accounts={accounts}
          onSaved={() => { setLocalGen((g) => g + 1); onChanged(); showToast("가설 규칙 추가됨"); }} />
      </div>

      {preview && (
        <div className="scenario-preview">
          <span>1년 뒤 — 현재 패턴 유지: <b className="num" style={{ fontVariantNumeric: "tabular-nums" }}>{fmtWon(preview.base)}</b></span>
          <span>이 시나리오: <b style={{ color: "var(--accent)" }}>{fmtWon(preview.mine)}</b></span>
          <span>차이: <b style={{ color: preview.mine >= preview.base ? "var(--accent)" : "var(--danger)" }}>{fmtDelta(preview.mine - preview.base)}</b></span>
        </div>
      )}
    </div>
  );
}

export function Scenarios({ gen, refresh, showToast }: ViewProps) {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [forkDate, setForkDate] = useState(todayIso());
  const [checked, setChecked] = useState<number[]>(chartToggles.get());
  const [limitMsg, setLimitMsg] = useState(false);

  useEffect(() => {
    api.scenarios().then(setScenarios);
    api.accounts().then(setAccounts);
  }, [gen]);

  const create = async () => {
    const sc = await api.createScenario({ name: name.trim(), fork_date: forkDate });
    setName("");
    refresh();
    setOpenId(sc.id);
    const next = [...checked, sc.id].slice(-3);
    setChecked(next);
    chartToggles.set(next);
    showToast(`시나리오 생성 · 실제 장부의 규칙 ${sc.copied_rules}개가 복사됨`);
  };

  // 차트 표시 최대 3개 — 4번째는 안내, 강제 해제 금지 (D19)
  const toggle = (id: number) => {
    setLimitMsg(false);
    if (checked.includes(id)) {
      const next = checked.filter((x) => x !== id);
      setChecked(next); chartToggles.set(next);
    } else if (checked.length >= 3) {
      setLimitMsg(true);
    } else {
      const next = [...checked, id];
      setChecked(next); chartToggles.set(next);
    }
  };

  const open = scenarios.find((s) => s.id === openId);

  return (
    <div>
      <h1>시나리오</h1>

      <div className="scenario-create">
        <div className="field"><label htmlFor="scenario-name">이름</label>
          <input id="scenario-name" style={{ width: 240 }} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="예: 월 100만 더 저축하면?" onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} /></div>
        <div className="field"><label htmlFor="scenario-fork-date">분기 시작일</label>
          <input id="scenario-fork-date" type="date" value={forkDate} onChange={(e) => setForkDate(e.target.value)} /></div>
        <button className="btn primary" disabled={!name.trim()} onClick={create}>+ 새 시나리오</button>
      </div>

      {limitMsg && <div className="banner err">차트에는 최대 3개 시나리오만 — 하나를 끄고 다시 켜세요.</div>}

      {scenarios.length === 0 ? (
        <div className="empty-wrap" style={{ minHeight: "30vh" }}>
          <div className="empty">
            <h2 style={{ fontSize: 17, marginBottom: 6 }}>첫 시나리오를 만들어보세요</h2>
            <p style={{ color: "var(--muted)", fontSize: 13.5 }}>
              예: "월 100만 더 저축하면?" — 실제 장부는 그대로 두고, 가설의 1년 뒤 순자산을 계산합니다.
            </p>
          </div>
        </div>
      ) : (
        <div className="table-scroll scenarios-list">
          <table className="ledger">
            <thead>
              <tr><th>이름</th><th>분기일</th><th style={{ width: 90 }}>차트에 표시</th><th /></tr>
            </thead>
            <tbody>
              {scenarios.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td style={{ color: "var(--muted)" }}>{s.fork_date}</td>
                  <td style={{ textAlign: "center" }}>
                    <input type="checkbox" aria-label={`${s.name} 차트에 표시`}
                      checked={checked.includes(s.id)} onChange={() => toggle(s.id)} />
                  </td>
                  <td><button className="btn sm secondary" aria-expanded={openId === s.id}
                    onClick={() => setOpenId(openId === s.id ? null : s.id)}>
                    {openId === s.id ? "닫기" : "열기"}
                  </button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <ScenarioEditor scenario={open} accounts={accounts} onChanged={refresh} showToast={showToast} />
      )}
    </div>
  );
}
