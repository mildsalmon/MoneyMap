import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, chartToggles, type Scenario } from "../../api";
import type { ViewProps } from "../../App";
import { useQuery } from "./useQuery";
import { ScenarioOverview } from "./ScenarioOverview";
import { ScenarioRules } from "./ScenarioRules";
import { LegacyResolution } from "./LegacyResolution";
import { DeleteScenarioDialog } from "./DeleteScenarioDialog";

const tabs = [
  { path: "", label: "개요" },
  { path: "assumptions", label: "가정" },
  { path: "info", label: "정보" },
];

function Information({
  scenario,
  onChanged,
  onDeleted,
  showToast,
}: {
  scenario: Scenario;
  onChanged: () => void;
  onDeleted: () => void;
  showToast: ViewProps["showToast"];
}) {
  const navigate = useNavigate();
  const [name, setName] = useState(scenario.name);
  const [description, setDescription] = useState(scenario.description);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!busy && error) saveButton.current?.focus();
  }, [busy, error]);
  const readonly = scenario.status === "archived";
  const transition = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.transitionScenario(
        scenario.id,
        readonly ? "restore" : "archive",
        scenario.version,
      );
      if (!mounted.current) return;
      if (result.status === "archived")
        chartToggles.set(chartToggles.get().filter((id) => id !== scenario.id));
      onChanged();
      showToast(
        readonly ? "시나리오를 복원했습니다" : "시나리오를 보관했습니다",
      );
      navigate(`/scenarios/${scenario.id}${readonly ? "" : "/info"}`);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section>
      <h2>기본 정보</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError("");
          try {
            await api.editScenario(scenario.id, {
              name: name.trim(),
              description,
              version: scenario.version,
            });
            if (!mounted.current) return;
            onChanged();
            showToast("시나리오 정보를 저장했습니다");
          } catch (e) {
            if (mounted.current) setError((e as Error).message);
          } finally {
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="detail-name">이름</label>
          <input
            id="detail-name"
            value={name}
            disabled={readonly}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="detail-description">설명</label>
          <textarea
            id="detail-description"
            value={description}
            disabled={readonly}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <p>시작 기준일: {scenario.fork_date} · 기준 장부: 실제 장부</p>
        <p>생성 시각: {scenario.created_at}</p>
        {!readonly && (
          <button
            ref={saveButton}
            className="btn primary"
            disabled={busy || !name.trim()}
          >
            정보 저장
          </button>
        )}
      </form>
      {error && (
        <p role="alert">
          {error}{" "}
          <button className="btn" onClick={onChanged}>
            입력을 유지하고 최신 버전 확인
          </button>
        </p>
      )}
      <div className="scenario-controls">
        <button className="btn secondary" disabled={busy} onClick={transition}>
          {readonly ? "복원" : "보관"}
        </button>
        {readonly && (
          <button className="btn danger" onClick={() => setDeleting(true)}>
            영구 삭제…
          </button>
        )}
      </div>
      {deleting && (
        <DeleteScenarioDialog
          scenario={scenario}
          close={() => setDeleting(false)}
          deleted={(message) => {
            if (!mounted.current) return;
            chartToggles.set(
              chartToggles.get().filter((id) => id !== scenario.id),
            );
            showToast(message);
            onDeleted();
            navigate("/scenarios/archived");
          }}
        />
      )}
    </section>
  );
}

export function ScenarioDetail({ gen, refresh, showToast }: ViewProps) {
  const { id, tab = "" } = useParams();
  const navigate = useNavigate();
  const sid = Number(id);
  const query = useQuery(`scenario:${id}`, (signal) =>
    api.scenario(sid, signal),
  );
  const [scenario, setScenario] = useState<Scenario>();
  const [loadError, setLoadError] = useState("");
  const title = useRef<HTMLHeadingElement>(null);
  const metadataRequest = useRef<AbortController | null>(null);
  // Each visit owns its callbacks, including A → B → A history navigation.
  const routeLifetime = useMemo(() => ({ active: false }), [sid]);
  useEffect(
    () => {
      routeLifetime.active = true;
      return () => {
        routeLifetime.active = false;
        metadataRequest.current?.abort();
      };
    },
    [routeLifetime],
  );
  useEffect(() => {
    setScenario(query.data);
  }, [query.data]);
  useEffect(() => {
    title.current?.focus();
  }, [scenario?.id]);
  // Refresh metadata without unmounting forms, so a conflict never discards drafts.
  const changed = () => {
    if (!routeLifetime.active) return;
    metadataRequest.current?.abort();
    const controller = new AbortController();
    metadataRequest.current = controller;
    setLoadError("");
    api
      .scenario(sid, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && routeLifetime.active) setScenario(value);
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted && routeLifetime.active) setLoadError(error.message);
      });
    refresh();
  };
  if (!tabs.some((t) => t.path === tab) || !Number.isInteger(sid) || sid <= 1)
    return (
      <section>
        <h1>시나리오를 찾을 수 없습니다</h1>
        <Link to="/scenarios">목록으로</Link>
      </section>
    );
  if (query.error)
    return (
      <section>
        <h1>시나리오를 불러올 수 없습니다</h1>
        <p role="alert">{query.error}</p>
        <button className="btn" onClick={query.reload}>
          다시 불러오기
        </button>
        <Link to="/scenarios">목록으로</Link>
      </section>
    );
  if (!scenario || scenario.id !== sid)
    return <p role="status">시나리오를 불러오는 중…</p>;
  const index = tabs.findIndex((t) => t.path === tab);
  return (
    <section className="scenario-detail">
      <Link
        to={
          scenario.status === "archived" ? "/scenarios/archived" : "/scenarios"
        }
      >
        {scenario.status === "archived" ? "보관함으로" : "시나리오 목록"}
      </Link>
      <h1 className="scenario-title" ref={title} tabIndex={-1}>
        {scenario.name}
      </h1>
      <p>
        {scenario.fork_date} 시작 ·{" "}
        {scenario.status === "archived"
          ? "보관 · 읽기 전용 · 최신 실제 장부로 다시 계산"
          : "최신 실제 규칙 + 시나리오 추가 가정"}
      </p>
      {loadError && (
        <p role="alert">
          {loadError}{" "}
          <button className="btn" onClick={changed}>
            다시 불러오기
          </button>
        </p>
      )}
      <div role="tablist" aria-label="시나리오 상세" className="scenario-tabs">
        {tabs.map((item, i) => (
          <button
            key={item.path}
            id={`scenario-tab-${i}`}
            role="tab"
            aria-selected={index === i}
            aria-controls="scenario-tab-panel"
            tabIndex={index === i ? 0 : -1}
            onClick={() =>
              navigate(`/scenarios/${sid}${item.path ? `/${item.path}` : ""}`)
            }
            onKeyDown={(e) => {
              let next = i;
              if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
              else if (e.key === "ArrowLeft")
                next = (i + tabs.length - 1) % tabs.length;
              else if (e.key === "Home") next = 0;
              else if (e.key === "End") next = tabs.length - 1;
              else return;
              e.preventDefault();
              navigate(
                `/scenarios/${sid}${tabs[next].path ? `/${tabs[next].path}` : ""}`,
              );
              document.getElementById(`scenario-tab-${next}`)?.focus();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="scenario-tab-panel"
        aria-labelledby={`scenario-tab-${index}`}
        tabIndex={0}
      >
        {tab === "info" ? (
          <Information
            key={sid}
            scenario={scenario}
            onChanged={changed}
            onDeleted={refresh}
            showToast={showToast}
          />
        ) : scenario.rule_mode === "legacy_snapshot" ? (
          <LegacyResolution scenario={scenario} onChanged={changed} />
        ) : tab === "assumptions" ? (
          <ScenarioRules scenario={scenario} onChanged={changed} />
        ) : (
          <ScenarioOverview scenario={scenario} gen={gen} />
        )}
      </div>
    </section>
  );
}
