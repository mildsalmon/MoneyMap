import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, chartToggles } from "../api";
import { todayIso } from "../format";
import type { ViewProps } from "../App";
import { useQuery } from "./scenarios/useQuery";

export function Scenarios({
  gen,
  refresh,
  showToast,
  archived = false,
}: ViewProps & { archived?: boolean }) {
  const navigate = useNavigate();
  const query = useQuery(`scenarios:${archived}:${gen}`, (signal) =>
    api.scenarios(archived ? "archived" : "active", signal),
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [forkDate, setForkDate] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<number[]>(chartToggles.get());
  const heading = useRef<HTMLHeadingElement>(null);
  const visit = useMemo(() => ({ active: false }), [archived]);
  useEffect(() => {
    visit.active = true;
    setBusy(false);
    setError("");
    return () => { visit.active = false; };
  }, [visit]);
  useEffect(() => {
    heading.current?.focus();
  }, [archived]);
  useEffect(() => {
    if (query.data && !archived) {
      const ids = chartToggles
        .get()
        .filter((id) => query.data!.some((s) => s.id === id));
      chartToggles.set(ids);
      setChecked(ids);
    }
  }, [query.data, archived]);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const { scenario } = await api.createScenario({
        name: name.trim(),
        description,
        fork_date: forkDate,
      });
      if (!visit.active) return;
      chartToggles.set([...chartToggles.get(), scenario.id]);
      refresh();
      showToast("시나리오를 만들었습니다");
      navigate(`/scenarios/${scenario.id}`);
    } catch (e) {
      if (visit.active) setError((e as Error).message);
    } finally {
      if (visit.active) setBusy(false);
    }
  };
  return (
    <section>
      <div className="scenario-heading">
        <h1 ref={heading} tabIndex={-1}>
          {archived ? "시나리오 보관함" : "시나리오"}
        </h1>
        <Link to={archived ? "/scenarios" : "/scenarios/archived"}>
          {archived ? "활성 시나리오" : "보관함"}
        </Link>
      </div>
      {!archived && (
        <form
          className="scenario-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="field">
            <label htmlFor="scenario-name">이름</label>
            <input
              disabled={busy}
              id="scenario-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="scenario-description">설명</label>
            <input
              disabled={busy}
              id="scenario-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="scenario-fork-date">시작 기준일</label>
            <input
              disabled={busy}
              id="scenario-fork-date"
              type="date"
              max={todayIso()}
              value={forkDate}
              onChange={(e) => setForkDate(e.target.value)}
              required
            />
          </div>
          <button className="btn primary" disabled={busy || !name.trim()}>
            + 새 시나리오
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      {query.error ? (
        <p role="alert">
          {query.error}{" "}
          <button className="btn" onClick={query.reload}>
            다시 불러오기
          </button>
        </p>
      ) : !query.data ? (
        <p role="status">목록을 불러오는 중…</p>
      ) : query.data.length === 0 ? (
        <p>
          {archived
            ? "보관된 시나리오가 없습니다"
            : "첫 시나리오를 만들어보세요"}
        </p>
      ) : (
        <div className="table-scroll">
          <table className="ledger">
            <thead>
              <tr>
                <th>이름</th>
                <th>시작 기준일</th>
                <th>상태</th>
                {!archived && <th>차트에 표시</th>}
                <th>상세</th>
              </tr>
            </thead>
            <tbody>
              {query.data.map((s) => (
                <tr key={s.id}>
                  <td className="scenario-list-name" title={s.name}>
                    {s.name}
                  </td>
                  <td>{s.fork_date}</td>
                  <td>
                    {archived
                      ? "보관 · 읽기 전용"
                      : s.rule_mode === "legacy_snapshot"
                        ? "기존 가정 분류 필요"
                        : "활성"}
                  </td>
                  {!archived && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${s.name} 차트에 표시`}
                        checked={checked.includes(s.id)}
                        onChange={() => {
                          if (!checked.includes(s.id) && checked.length >= 3) {
                            setError(
                              "차트에는 최대 3개 시나리오만 표시할 수 있습니다",
                            );
                            return;
                          }
                          const next = checked.includes(s.id)
                            ? checked.filter((id) => id !== s.id)
                            : [...checked, s.id];
                          chartToggles.set(next);
                          setChecked(next);
                          setError("");
                        }}
                      />
                    </td>
                  )}
                  <td>
                    <Link to={`/scenarios/${s.id}`}>열기</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
