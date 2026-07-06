/**
 * 거래 입력 — 가계부의 심장 (D22: 템플릿 4탭 + 고급, D12: 키보드 흐름).
 * 템플릿이 분류(차변/대변)를 대신하고, 우측 미리보기가 신뢰 장치로
 * 항상 같은 자리에서 검산을 보여준다.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { accountTree, api, isPostable, type Account, type Txn } from "../api";
import { commaInput, fmtDelta, fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";

type Tab = "expense" | "income" | "transfer" | "card" | "advanced";

const TABS: { id: Tab; label: string }[] = [
  { id: "expense", label: "지출" },
  { id: "income", label: "수입" },
  { id: "transfer", label: "이체" },
  { id: "card", label: "카드값 납부" },
  { id: "advanced", label: "고급" },
];

const NW_TYPES = new Set(["asset", "liability"]);

function AccountSelect({
  accounts, value, onChange, filter, label,
}: {
  accounts: Account[];
  value: number | "";
  onChange: (v: number) => void;
  filter: (a: Account) => boolean;
  label: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        <option value="">선택</option>
        {/* 계정 트리 들여쓰기 — 같은 유형끼리만 부모가 될 수 있어 필터 후에도 트리가 온전하다.
            보관된 계정(D23)은 새 입력에서 제외 (과거 거래의 이름 표시는 영향 없음) */}
        {accountTree(accounts.filter((a) => !a.archived && filter(a))).map(({ account: a, depth }) => (
          <option key={a.id} value={a.id} disabled={!isPostable(accounts, a)}>
            {"  ".repeat(depth) + (depth > 0 ? "· " : "") + a.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TxnInput({ gen, refresh, showToast, go }: ViewProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [recent, setRecent] = useState<Txn[]>([]);
  const [tab, setTab] = useState<Tab>("expense");
  const [date, setDate] = useState(todayIso());
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [acc1, setAcc1] = useState<number | "">(""); // 탭별 첫 계정 (비용/수익/from/카드)
  const [acc2, setAcc2] = useState<number | "">(""); // 탭별 둘째 계정 (결제수단/입금/to/출금)
  const [advRows, setAdvRows] = useState<{ account: number | ""; amount: string; debit: boolean }[]>([
    { account: "", amount: "", debit: true },
    { account: "", amount: "", debit: false },
  ]);
  const [err, setErr] = useState("");
  const amountRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.accounts().then(setAccounts);
    api.transactions().then((t) => setRecent(t.slice(-8).reverse()));
  }, [gen]);

  const typeOf = useMemo(() => new Map(accounts.map((a) => [a.id, a.type])), [accounts]);
  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? `#${id}`;
  const value = commaInput(amount).value;

  // 카드값 탭: 카드 선택 시 현재 부채 잔액 자동 채움 (수정 가능 = 부분 납부, D18)
  useEffect(() => {
    if (tab !== "card" || acc1 === "") return;
    api.balances().then((b) => {
      const bal = b.accounts.find((x) => x.account_id === acc1);
      if (bal && !amount) setAmount(commaInput(String(Math.abs(bal.balance))).display);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc1, tab]);

  // 미리보기 postings (저장 payload와 동일 소스 — 미리보기가 곧 진실)
  const postings = useMemo((): { account_id: number; amount: number }[] => {
    if (tab === "advanced") {
      return advRows
        .filter((r) => r.account !== "" && commaInput(r.amount).value > 0)
        .map((r) => ({
          account_id: r.account as number,
          amount: (r.debit ? 1 : -1) * commaInput(r.amount).value,
        }));
    }
    if (!value || acc1 === "" || acc2 === "") return [];
    switch (tab) {
      case "expense":   // 비용 차변 / 결제수단 대변
        return [{ account_id: acc1 as number, amount: value }, { account_id: acc2 as number, amount: -value }];
      case "income":    // 자산 차변 / 수익 대변
        return [{ account_id: acc2 as number, amount: value }, { account_id: acc1 as number, amount: -value }];
      case "transfer":  // to 차변 / from 대변
        return [{ account_id: acc2 as number, amount: value }, { account_id: acc1 as number, amount: -value }];
      case "card":      // 카드(부채 감소) 차변 / 출금계좌 대변
        return [{ account_id: acc1 as number, amount: value }, { account_id: acc2 as number, amount: -value }];
    }
  }, [tab, value, acc1, acc2, advRows]);

  const balanced = postings.length >= 2 && postings.reduce((s, p) => s + p.amount, 0) === 0;
  const nwDelta = postings.reduce(
    (s, p) => s + (NW_TYPES.has(typeOf.get(p.account_id) ?? "") ? p.amount : 0), 0);

  const resetAfterSave = () => {
    setAmount("");
    if (tab === "advanced") setAdvRows([{ account: "", amount: "", debit: true }, { account: "", amount: "", debit: false }]);
    amountRef.current?.focus(); // D12: 저장 후 계속 — 날짜·계정 유지, 금액 비움+포커스
  };

  const save = async (thenDashboard = false) => {
    setErr("");
    if (!balanced) return;
    try {
      const txn = await api.createTransaction({ date, description: desc.trim(), postings });
      refresh();
      const deltaMsg = nwDelta !== 0 ? ` · 순자산 ${fmtDelta(nwDelta)} 반영` : "";
      showToast(`저장됨${deltaMsg}`, async () => {
        await api.deleteTransaction(txn.id);
        refresh();
      });
      if (thenDashboard) go("dashboard");
      else resetAfterSave();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  // D22: 내역 자동배치 — 과거 동일 내역이 있으면 빈 필드만 채운다
  const autofill = (d: string) => {
    setDesc(d);
    if (amount || tab !== "expense") return;
    const past = recent.find((t) => t.description === d && t.postings.length === 2);
    if (!past) return;
    const debit = past.postings.find((p) => p.amount.amount > 0);
    const credit = past.postings.find((p) => p.amount.amount < 0);
    if (debit && credit && typeOf.get(debit.account_id) === "expense") {
      setAmount(commaInput(String(debit.amount.amount)).display);
      setAcc1(debit.account_id);
      setAcc2(credit.account_id);
    }
  };

  const onAmountKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save(false);
  };

  const amountField = (
    <div className="field">
      <label>금액</label>
      <input ref={amountRef} className="num" style={{ width: 150, fontSize: 17, fontWeight: 650 }}
        placeholder="0" value={amount}
        onChange={(e) => setAmount(commaInput(e.target.value).display)}
        onKeyDown={onAmountKey} />
    </div>
  );
  const dateField = (
    <div className="field"><label>날짜</label>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
  );
  const descField = (
    <div className="field"><label>내역 (선택)</label>
      <input style={{ width: 160 }} value={desc} onChange={(e) => autofill(e.target.value)}
        placeholder="예: 점심" list="desc-suggest" onKeyDown={onAmountKey} />
      <datalist id="desc-suggest">
        {[...new Set(recent.map((t) => t.description).filter(Boolean))].map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
    </div>
  );

  const isAssetish = (a: Account) => a.type === "asset" || a.type === "liability";

  return (
    <div>
      <h1>거래 입력</h1>
      <div className="tabs">
        {TABS.map((t) => (
          <span key={t.id} className={`tab ${tab === t.id ? "on" : ""}`}
            style={t.id === "advanced" ? { marginLeft: "auto", fontSize: 12.5 } : undefined}
            onClick={() => { setTab(t.id); setAcc1(""); setAcc2(""); setAmount(""); setErr(""); }}>
            {t.label}
          </span>
        ))}
      </div>

      <div className="two" style={{ marginTop: 0, gridTemplateColumns: "1.2fr 1fr" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {tab === "expense" && (<>
            <div style={{ display: "flex", gap: 10 }}>{dateField}{amountField}</div>
            <AccountSelect accounts={accounts} value={acc1} onChange={setAcc1} label="무엇에? (비용)"
              filter={(a) => a.type === "expense"} />
            <AccountSelect accounts={accounts} value={acc2} onChange={setAcc2} label="어디서 나갔나? (결제 수단)"
              filter={isAssetish} />
            {descField}
          </>)}
          {tab === "income" && (<>
            <div style={{ display: "flex", gap: 10 }}>{dateField}{amountField}</div>
            <AccountSelect accounts={accounts} value={acc1} onChange={setAcc1} label="무엇으로? (수익)"
              filter={(a) => a.type === "income"} />
            <AccountSelect accounts={accounts} value={acc2} onChange={setAcc2} label="어디로 들어왔나? (자산)"
              filter={(a) => a.type === "asset"} />
            {descField}
          </>)}
          {tab === "transfer" && (<>
            <div style={{ display: "flex", gap: 10 }}>{dateField}{amountField}</div>
            <AccountSelect accounts={accounts} value={acc1} onChange={setAcc1} label="어디서 (from)"
              filter={(a) => a.type === "asset"} />
            <AccountSelect accounts={accounts} value={acc2} onChange={setAcc2} label="어디로 (to)"
              filter={(a) => a.type === "asset"} />
            {descField}
          </>)}
          {tab === "card" && (<>
            <div style={{ display: "flex", gap: 10 }}>{dateField}</div>
            <AccountSelect accounts={accounts} value={acc1} onChange={setAcc1} label="어느 카드? (잔액 자동 채움)"
              filter={(a) => a.type === "liability"} />
            {amountField}
            <AccountSelect accounts={accounts} value={acc2} onChange={setAcc2} label="어디서 출금? (계좌)"
              filter={(a) => a.type === "asset"} />
            {descField}
          </>)}
          {tab === "advanced" && (<>
            <div style={{ display: "flex", gap: 10 }}>{dateField}{descField}</div>
            {advRows.map((r, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div className="field"><label>{i === 0 ? "계정" : ""}</label>
                  <select value={r.account}
                    onChange={(e) => setAdvRows((rows) => rows.map((x, j) => j === i ? { ...x, account: Number(e.target.value) } : x))}>
                    <option value="">선택</option>
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select></div>
                <div className="field"><label>{i === 0 ? "차변/대변" : ""}</label>
                  <select value={r.debit ? "d" : "c"}
                    onChange={(e) => setAdvRows((rows) => rows.map((x, j) => j === i ? { ...x, debit: e.target.value === "d" } : x))}>
                    <option value="d">차변 (+)</option><option value="c">대변 (−)</option>
                  </select></div>
                <div className="field"><label>{i === 0 ? "금액" : ""}</label>
                  <input className="num" style={{ width: 120 }} placeholder="0" value={r.amount}
                    onChange={(e) => setAdvRows((rows) => rows.map((x, j) => j === i ? { ...x, amount: commaInput(e.target.value).display } : x))} /></div>
                {advRows.length > 2 && (
                  <button className="btn sm secondary" onClick={() => setAdvRows((rows) => rows.filter((_, j) => j !== i))}>−</button>
                )}
              </div>
            ))}
            <div><button className="btn sm secondary"
              onClick={() => setAdvRows((rows) => [...rows, { account: "", amount: "", debit: true }])}>+ 행 추가</button></div>
          </>)}

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button className="btn primary" disabled={!balanced} onClick={() => save(false)}>저장 (Enter)</button>
            <button className="btn secondary" disabled={!balanced} onClick={() => save(true)}>저장 후 대시보드</button>
            {err && <span style={{ color: "var(--danger)", fontSize: 12, alignSelf: "center" }}>{err}</span>}
          </div>
        </div>

        {/* 복식 미리보기 — 장식이 아니라 신뢰 장치 */}
        <div className="panel" style={{ alignSelf: "flex-start" }}>
          <h4>이 입력이 만드는 복식부기</h4>
          <table className="ledger">
            <thead><tr><th>계정</th><th className="num">차변</th><th className="num">대변</th></tr></thead>
            <tbody>
              {postings.map((p, i) => (
                <tr key={i}>
                  <td>{nameOf(p.account_id)}</td>
                  <td className="num">{p.amount > 0 ? p.amount.toLocaleString("ko-KR") : "—"}</td>
                  <td className="num">{p.amount < 0 ? (-p.amount).toLocaleString("ko-KR") : "—"}</td>
                </tr>
              ))}
              {postings.length === 0 && (
                <tr><td colSpan={3} style={{ color: "var(--faint)" }}>금액과 계정을 채우면 여기 나타납니다</td></tr>
              )}
            </tbody>
          </table>
          {/* 검산은 표 밖에 별도 표기 — 표 안에 섞으면 거래 행처럼 읽힌다 */}
          {postings.length > 0 && (() => {
            const debit = postings.filter((p) => p.amount > 0).reduce((s, p) => s + p.amount, 0);
            const credit = -postings.filter((p) => p.amount < 0).reduce((s, p) => s + p.amount, 0);
            return (
              <div style={{
                marginTop: 10, padding: "7px 10px", borderRadius: 4, fontSize: 12.5,
                fontVariantNumeric: "tabular-nums",
                background: balanced ? "var(--accent-soft)" : "var(--danger-soft)",
                color: balanced ? "var(--accent)" : "var(--danger)",
                border: `1px solid ${balanced ? "var(--accent)" : "var(--danger)"}`,
              }}>
                {balanced
                  ? `✓ 검산 일치 — 차변 ${debit.toLocaleString("ko-KR")} = 대변 ${credit.toLocaleString("ko-KR")}`
                  : `✗ 검산 불일치 — 차변 ${debit.toLocaleString("ko-KR")} · 대변 ${credit.toLocaleString("ko-KR")} (차이 ${(debit - credit).toLocaleString("ko-KR")})`}
              </div>
            );
          })()}
          {tab === "card" && (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
              카드값 납부 = 부채 감소. 지출로 이중 계상되지 않습니다.
            </div>
          )}
          {postings.length > 0 && nwDelta !== 0 && (
            <div style={{ fontSize: 12.5, marginTop: 8 }}>
              순자산 변화: <b style={{ color: nwDelta > 0 ? "var(--accent)" : "var(--ink)" }}>{fmtDelta(nwDelta)}</b>
            </div>
          )}
        </div>
      </div>

      {/* 최근 입력 — 클릭하면 폼에 불러오기 (즉시 저장 아님, D12) */}
      {recent.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h4 style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 6 }}>방금 입력한 내역 (최근 순)</h4>
          <table className="ledger" style={{ maxWidth: 720 }}>
            <tbody>
              {recent.slice(0, 5).map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }}
                  onClick={() => t.description && autofill(t.description)}>
                  <td style={{ color: "var(--muted)", width: 100 }}>{t.date}</td>
                  <td>{t.description || "—"} {t.source_rule_id && <span className="badge auto">자동</span>}</td>
                  <td className="num">
                    {fmtWon(t.postings.filter((p) => p.amount.amount > 0).reduce((s, p) => s + p.amount.amount, 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
