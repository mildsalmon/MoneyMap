import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { fx, nativeQuantity, scales, type Candidate, type Currency, type Preview, type Quote, type Recorded, type Trade } from "../api/fx";
import { fmtMoney, fmtWon, todayIso } from "../format";
import { useQuery } from "./scenarios/useQuery";
import { accountPickerModel } from "./TransactionAccountPicker";
import "./reconciliation.css";
import "./fx.css";

const currencies = Object.keys(scales) as Currency[];
const newTrade = (day: string): Trade => ({
  day, side: "buy", bank_id: 0, currency: "USD", quantity: "", cash: "", fee: "0", rate: "", rate_date: day, source: "",
});
const won = (value: string | null) => value === null ? "—" : fmtWon(BigInt(value));
const legacyLabels: Record<string,string> = {
  bank: "원화 통장", expense: "기존 비용", fee: "수수료", krw_clearing: "원화 상대계정", holding: "외화 현금", native_clearing: "외화 상대계정",
};
function CurrencyOptions() { return currencies.map(c => <option key={c}>{c}</option>); }

export function FxLedger({ refresh }: { refresh: () => void }) {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requested = params.get("day");
  const day = requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : todayIso();
  function setDay(at: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set("day", at);
      return next;
    }, {replace: true, preventScrollReset: true});
  }
  const [revision, setRevision] = useState(0);
  const [trade, setTrade] = useState(() => newTrade(todayIso()));
  const [editing, setEditing] = useState<Recorded>();
  const [selected, setSelected] = useState<Candidate>();
  const [preview, setPreview] = useState<Preview>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [quote, setQuote] = useState<Omit<Quote, "rate_date">>({ currency: "USD", rate: "", source: "" });
  const [overrideDay, setOverrideDay] = useState<string | null>(null);
  const quoteDay = overrideDay ?? day;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const report = useQuery(`${day}/${revision}`, signal => fx.report(day, signal));
  const legacy = useQuery(String(revision), fx.candidates);
  const accounts = useQuery(trade.day, signal => api.datedAccounts(trade.day, signal));
  const picker = accountPickerModel(accounts.data ?? []);
  const banks = [...picker.available].filter(id => {
    const account = picker.byId.get(id)!;
    return account.currency === "KRW" && account.type === "asset";
  });
  const data = report.data;
  useEffect(() => {
    if (data && /^#fx-\d+$/.test(location.hash)) {
      document.getElementById(location.hash.slice(1))?.focus();
    }
  }, [location.hash, data]);

  function updateTrade(patch: Partial<Trade>) {
    setTrade(prev => ({ ...prev, ...patch }));
    setRequestId(crypto.randomUUID());
    setPreview(undefined);
    setNotice("");
  }
  function reset(at = day) {
    setSelected(undefined); setEditing(undefined); updateTrade(newTrade(at));
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await action();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setPreview(undefined);
      setError(e instanceof ApiError && e.status === 422
        ? "수량의 소수 자릿수, 환율, 실제 입출금액과 수수료를 확인하세요." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function changed(at: string) {
    setDay(at); setRevision(n => n + 1); refresh();
  }
  function edit(row: Recorded) {
    const {currency, rate, rate_date, source, side, bank_id, day, cash, fee} = row;
    setSelected(undefined); setEditing(row);
    updateTrade({currency, rate, rate_date, source, side, bank_id, day, cash, fee, quantity: nativeQuantity(row.minor, currency)});
    document.getElementById("fx-trade")?.focus();
  }
  function selectLegacy(row: Candidate) {
    setEditing(undefined); setSelected(row);
    updateTrade({...newTrade(row.day), cash: row.cash, bank_id: row.bank_id});
    document.getElementById("fx-trade")?.focus();
  }
  async function submitTrade() {
    if (selected && !preview) {
      setPreview(await fx.preview(trade, selected.transaction_id)); return;
    }
    const receipt = selected && preview
      ? await fx.apply(trade, selected.transaction_id, preview.preview_hash)
      : await fx.save(trade, requestId, editing);
    reset(trade.day); changed(trade.day); setNotice(`환전 #${receipt.id} 저장 완료`);
  }

  return <section className="fx-ledger reconciliation">
    <h1>외화 원장</h1>
    {error && <p role="alert" className="row-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <section className="panel">
      <h2>보유 외화 평가</h2>
      <label className="field">평가일<input type="date" required value={day} onChange={e => {
        if (e.target.value) setDay(e.target.value);
      }}/></label>
      {report.error && <p role="alert">{report.error} <button onClick={report.reload}>다시 조회</button></p>}
      {data && <>
        <dl className="reconcile-balances">
          <div><dt>원화 순자산</dt><dd>{won(data.krw)}</dd></div>
          <div><dt>평가한 외화 소계</dt><dd>{won(data.foreign_subtotal)}</dd></div>
          <div><dt>{data.missing ? "평가 가능한 순자산 소계" : "환산 순자산"}</dt><dd>{won(data.valued_net)}</dd></div>
        </dl>
        {data.missing > 0 && <p>당일 환율이 없는 잔액 {data.missing}건은 소계에서 제외했습니다.</p>}
        {data.balances.length === 0 ? <p>평가일까지 기록한 외화 잔액이 없습니다.</p> :
          <div className="table-scroll"><table><caption>계정별 원통화와 원화 평가액</caption>
            <thead><tr>{["계정", "원통화 잔액", "취득원가", "평가액", "미실현 손익", "실현 손익", "누적 수수료"].map(x => <th key={x}>{x}</th>)}</tr></thead>
            <tbody>{data.balances.map(b => <tr key={b.account_id + b.currency}><th>{b.name}</th>
              <td>{fmtMoney(BigInt(b.minor), b.currency)}</td><td>{won(b.cost)}</td><td>{b.value === null ? "미평가" : won(b.value)}</td>
              <td>{won(b.unrealized)}</td><td>{won(b.realized)}</td><td>{won(b.fees)}</td></tr>)}</tbody></table></div>}
        <p className="m">손익은 관리 보고 기준입니다. 매도 원가는 통화별 이동평균으로 배분하고, 수수료는 별도 비용으로 기록합니다.</p>
        {Object.values(data.quotes).map(q => <p key={q.currency}>{q.currency} 1단위 = {q.rate}원 · {q.rate_date} · {q.source}</p>)}
      </>}
      <details><summary>수동 평가환율 입력</summary>
        <form onSubmit={e => { e.preventDefault(); void run(async () => {
          await fx.quote({...quote, rate_date: quoteDay}); setOverrideDay(null); changed(quoteDay); setNotice("평가환율 저장 완료");
        }); }}><fieldset className="reconcile-fields" disabled={busy}>
          <legend>평가에 사용할 환율</legend>
          <label>평가 통화<select value={quote.currency} onChange={e => setQuote({...quote, currency: e.target.value as Currency})}><CurrencyOptions/></select></label>
          <label>평가 기준일<input required type="date" value={quoteDay} onChange={e => setOverrideDay(e.target.value === day ? null : e.target.value)}/></label>
          <label>평가환율 (원/1단위)<input required inputMode="decimal" pattern="[0-9]{1,12}([.][0-9]{1,9})?" value={quote.rate} onChange={e => setQuote({...quote, rate: e.target.value})}/></label>
          <label>평가환율 출처<input required maxLength={200} value={quote.source} onChange={e => setQuote({...quote, source: e.target.value})}/></label>
          <button className="btn secondary">평가환율 확정</button>
        </fieldset></form>
      </details>
    </section>
    <section className="panel">
      <h2 id="fx-trade" tabIndex={-1}>{selected ? `과거 비용 이관 · 원본 ${selected.source_row}행` : editing ? `환전 #${editing.id} 수정` : "환전 기록"}</h2>
      {accounts.error && <p role="alert">{accounts.error}</p>}
      {accounts.data && !banks.length && !selected && <Link to="/accounts">원화 통장 추가</Link>}
      <form onSubmit={e => { e.preventDefault(); void run(submitTrade); }}>
        <fieldset disabled={busy} className="reconcile-fields"><legend>명세서 확정 금액</legend>
          <label>매매 구분<select disabled={!!selected} value={trade.side} onChange={e => updateTrade({side: e.target.value as Trade["side"]})}><option value="buy">매수</option><option value="sell">매도</option></select></label>
          <label>거래일<input required disabled={!!selected} type="date" value={trade.day} onChange={e => updateTrade({day: e.target.value})}/></label>
          <label>원화 통장<select required disabled={!!selected} value={trade.bank_id || ""} onChange={e => updateTrade({bank_id: Number(e.target.value)})}>
            <option value="">통장 선택</option>{(selected && !banks.includes(selected.bank_id) ? [...banks,selected.bank_id] : banks).map(id => <option key={id} value={id}>{picker.paths.get(id) ?? `#${id}`}</option>)}
          </select></label>
          <label>거래 통화<select disabled={!!selected} value={trade.currency} onChange={e => updateTrade({currency: e.target.value as Currency})}><CurrencyOptions/></select></label>
          <label>외화 수량 ({trade.currency})<input required inputMode="decimal" value={trade.quantity} pattern={scales[trade.currency] ? `[0-9]+(\\.[0-9]{1,${scales[trade.currency]}})?` : "[0-9]+"} onChange={e => updateTrade({quantity: e.target.value})}/></label>
          <label>실제 {trade.side === "buy" ? "출금액" : "입금액"} (원)<input required disabled={!!selected} inputMode="numeric" pattern="[0-9]+" value={trade.cash} onChange={e => updateTrade({cash: e.target.value})}/></label>
          <label>수수료 (원)<input required inputMode="numeric" pattern="[0-9]+" value={trade.fee} onChange={e => updateTrade({fee: e.target.value})}/></label>
          <label>거래환율 (원/1단위)<input required inputMode="decimal" pattern="[0-9]{1,12}([.][0-9]{1,9})?" value={trade.rate} onChange={e => updateTrade({rate: e.target.value})}/></label>
          <label>거래환율 기준일<input required type="date" value={trade.rate_date} onChange={e => updateTrade({rate_date: e.target.value})}/></label>
          <label>거래환율 출처<input required maxLength={200} value={trade.source} onChange={e => updateTrade({source: e.target.value})}/></label>
        </fieldset>
        {preview && <div><h3>이관 전후 대사</h3><p>{preview.original.source_file} · {preview.original.source_row}행 · 원본 거래 #{preview.original.transaction_id}</p>
          <dl>{Object.entries(legacyLabels).map(([key,label]) => <div key={key}><dt>{label}</dt><dd>
            {fmtMoney(BigInt(preview.before[key]), ["holding","native_clearing"].includes(key) ? "USD" : "KRW")} → {fmtMoney(BigInt(preview.after[key]), ["holding","native_clearing"].includes(key) ? "USD" : "KRW")}</dd></div>)}</dl></div>}
        <div className="reconcile-actions"><button className="btn primary" disabled={busy}>{selected ? preview ? "백업 후 이관 확정" : "이관 미리보기" : editing ? "수정 저장" : "환전 저장"}</button>
          {(selected || editing) && <button type="button" className="btn secondary" disabled={busy} onClick={() => reset()}>취소</button>}</div>
      </form>
    </section>
    <section className="panel"><h2>환전 내역</h2>
      {data?.trades.length === 0 && <p>평가일까지 기록한 환전이 없습니다.</p>}
      {data?.trades.map(t => <article key={t.id} id={`fx-${t.id}`} tabIndex={-1}>
        <h3>#{t.id} {t.currency} {t.side === "buy" ? "매수" : "매도"} · {t.day}</h3>
        <p>{t.currency} {nativeQuantity(t.minor,t.currency)} · {t.side === "buy" ? "출금" : "입금"} {won(t.cash)} · 원금 {won(t.principal)} · 수수료 {won(t.fee)}</p>
        <p>거래환율 {t.rate}원 · {t.rate_date} · {t.source} · 원화 분개 #{t.krw_txn} · {t.currency} 분개 #{t.native_txn}</p>
        {t.legacy_txn ? <details><summary>원본 행과 백업</summary><p>거래 #{t.legacy_txn} · {t.source_file} · {t.source_row}행</p><p>SHA-256 {t.source_hash}</p><p>백업 {t.backup}</p></details> :
          <button className="btn secondary" disabled={busy} onClick={() => edit(t)}>환전 #{t.id} 수정</button>}
      </article>)}
    </section>
    <details className="panel"><summary>과거 USD 구매 선택 이관</summary>
      {legacy.error && <p role="alert">{legacy.error}</p>}
      {legacy.data?.length === 0 && <p>이관할 원본 비용 행이 없습니다.</p>}
      {legacy.data?.map(c => <p key={c.transaction_id}>{c.day} · {c.source_file} {c.source_row}행 · {won(c.cash)} <button className="btn secondary" disabled={busy} onClick={() => selectLegacy(c)}>원본 #{c.transaction_id} 선택</button></p>)}
    </details>
  </section>;
}
