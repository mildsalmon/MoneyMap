import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect, useRef, useState } from "react";
import { BarChart3, FolderTree, GitBranch, PenLine, Repeat, ScrollText } from "lucide-react";
import { api } from "./api";
import { Dashboard } from "./views/Dashboard";
import { TxnInput } from "./views/TxnInput";
import { History } from "./views/History";
import { Accounts } from "./views/Accounts";
import { Rules } from "./views/Rules";
import { Scenarios } from "./views/Scenarios";
import { ScenarioDetail } from "./views/scenarios/ScenarioDetail";

export type View = "dashboard" | "input" | "history" | "accounts" | "rules" | "scenarios";

const NAV: { id: View; label: string; icon: typeof BarChart3 }[] = [
  { id: "dashboard", label: "대시보드", icon: BarChart3 },
  { id: "input", label: "거래 입력", icon: PenLine },
  { id: "history", label: "거래 내역", icon: ScrollText },
  { id: "accounts", label: "계정·개시잔액", icon: FolderTree },
  { id: "rules", label: "반복 규칙", icon: Repeat },
  { id: "scenarios", label: "시나리오", icon: GitBranch },
];

export interface Toast {
  msg: string;
  undo?: () => Promise<void>;
}

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const paths: Record<View, string> = { dashboard: "/", input: "/transactions/new", history: "/transactions", accounts: "/accounts", rules: "/rules", scenarios: "/scenarios" };
  const view = location.pathname.startsWith("/scenarios") ? "scenarios" : (Object.keys(paths) as View[]).find(key => paths[key] === location.pathname);
  const setView = (next: View) => navigate(paths[next]);
  const [online, setOnline] = useState(true);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.status>> | null>(null);
  const [banner, setBanner] = useState<{ id: number; date: string; description: string }[]>([]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [gen, setGen] = useState(0); // 데이터 변경 세대 — 뷰 리프레시 트리거

  const refresh = useCallback(() => {
    setGen((g) => g + 1);
    api.health().then(() => setOnline(true)).catch(() => setOnline(false));
    api.status().then(setStatus).catch(() => {});
  }, []);

  const didInit = useRef(false);
  useEffect(() => {
    // 앱 시작: 반복 거래 materialize → 생성 배너 (D10)
    // StrictMode 이중 실행 가드 — 백엔드도 낙관적 잠금으로 방어하지만
    // 배너가 두 번 뜨는 것까지 막으려면 클라이언트 가드도 필요하다.
    if (didInit.current) return;
    didInit.current = true;
    api
      .materialize()
      .then((m) => {
        if (m.created > 0) setBanner(m.transactions);
        refresh();
      })
      .catch(() => setOnline(false));
    const t = setInterval(() => {
      api.health().then(() => setOnline(true)).catch(() => setOnline(false));
    }, 15_000);
    return () => clearInterval(t);
  }, [refresh]);

  const showToast = useCallback((msg: string, undo?: () => Promise<void>) => {
    setToast({ msg, undo });
    setTimeout(() => setToast((cur) => (cur?.msg === msg ? null : cur)), 6_000);
  }, []);

  const viewProps = { gen, refresh, showToast, go: setView };

  return (
    <div className="shell">
      <aside className="side">
        <div className="logo">MoneyMap</div>
        <nav>
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? "on" : ""}
              aria-current={view === id ? "page" : undefined} onClick={() => setView(id)}>
              <Icon size={15} strokeWidth={1.8} /> {label}
            </button>
          ))}
        </nav>
        <div className="health">
          {status ? (
            <>
              {status.trial_balance_ok ? "✓ 검산 정상" : <span style={{ color: "var(--danger)" }}>✗ 검산 불일치</span>}
              <br />
              {status.last_backup ? `✓ 백업: ${status.last_backup}` : <span className="m">백업 없음</span>}
              <br />
              <span className="m">마지막 입력: {status.last_entry ?? "—"}</span>
            </>
          ) : (
            <span className="m">상태 확인 중…</span>
          )}
        </div>
      </aside>

      <main className="main">
        {!online && (
          <div className="banner err">
            백엔드에 연결할 수 없습니다 — <code>scripts/dev.sh</code>가 실행 중인지 확인하세요.
          </div>
        )}

        {banner.length > 0 && (
          <div className="banner info">
            <PenLine size={14} /> 반복 거래 {banner.length}건이 생성되었습니다:
            {banner.map((t) => (
              <span key={t.id} className="badge auto">
                {t.date} {t.description}{" "}
                <button
                  style={{ border: "none", background: "none", color: "inherit", textDecoration: "underline" }}
                  onClick={async () => {
                    await api.deleteTransaction(t.id);
                    setBanner((b) => b.filter((x) => x.id !== t.id));
                    refresh();
                    showToast("자동 생성 거래를 삭제했습니다");
                  }}
                >
                  삭제
                </button>
              </span>
            ))}
            <button className="btn sm secondary" style={{ marginLeft: "auto" }} onClick={() => setBanner([])}>
              확인
            </button>
          </div>
        )}

        <Routes>
          <Route path="/" element={<Dashboard {...viewProps} />} />
          <Route path="/transactions/new" element={<TxnInput {...viewProps} />} />
          <Route path="/transactions" element={<History {...viewProps} />} />
          <Route path="/accounts" element={<Accounts {...viewProps} />} />
          <Route path="/rules" element={<Rules {...viewProps} />} />
          <Route path="/scenarios" element={<Scenarios {...viewProps} />} />
          <Route path="/scenarios/archived" element={<Scenarios {...viewProps} archived />} />
          <Route path="/scenarios/:id" element={<ScenarioDetail {...viewProps} />} />
          <Route path="/scenarios/:id/:tab" element={<ScenarioDetail {...viewProps} />} />
          <Route path="*" element={<section><h1>페이지를 찾을 수 없습니다</h1><button className="btn" onClick={() => navigate("/")}>대시보드로</button></section>} />
        </Routes>
      </main>

      {toast && (
        <div className="toast">
          <span className="toast-message">{toast.msg}</span>
          {toast.undo && (
            <button
              onClick={async () => {
                await toast.undo!();
                // An undo failure may replace this toast with recovery guidance.
                setToast(current => current === toast ? null : current);
              }}
            >
              실행취소
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface ViewProps {
  gen: number;
  refresh: () => void;
  showToast: (msg: string, undo?: () => Promise<void>) => void;
  go: (v: View) => void;
}
