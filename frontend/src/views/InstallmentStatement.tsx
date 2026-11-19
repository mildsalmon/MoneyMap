import { useState } from "react";
import type { InstallmentRow } from "../api/installments";
import { todayIso } from "../format";

export const optionalWon = (value: string) => value === "" ? null : Number(value);
export type StatementDraft = {principal: string; interest: string; fee: string};

export function StatementRows({rows, change}: {
  rows: StatementDraft[]; change: (index: number, field: keyof StatementDraft, value: string) => void;
}) {
  return <div className="installment-wide">
    <p>명세서의 회차별 금액을 원 단위로 입력하세요. 미확인 비용은 비워 두고, 면제된 비용은 0을 입력하세요.</p>
    <div className="table-scroll"><table className="ledger"><thead><tr><th>회차</th><th>원금</th><th>이자</th><th>수수료</th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}><td>{i+1}회</td>
        {(["principal","interest","fee"] as const).map((key, j) => <td key={key}><input type="number"
          aria-label={`${i+1}회 명세서 ${["원금","이자","수수료"][j]}`} min={key === "principal" ? 1 : 0}
          required={key === "principal"} value={row[key]} placeholder={key === "principal" ? "" : "미확인"}
          onChange={e => change(i, key, e.target.value)} /></td>)}</tr>)}</tbody>
    </table></div>
  </div>;
}

export function EditStatement({row, purchaseDate, disabled, save}: {
  row: InstallmentRow; purchaseDate: string; disabled: boolean; save: (body: Record<string, unknown>) => void;
}) {
  const [day, setDay] = useState(todayIso);
  const [values, setValues] = useState({
    interest: String(row.interest ?? ""), fee: String(row.fee ?? ""),
    cancelled_interest: String(row.cancelled_interest), early_fee: String(row.early_fee),
  });
  return <details><summary>{row.number}회 명세서·중도상환 조정</summary>
    <form onSubmit={e => {e.preventDefault(); save({effective_date: day, interest: optionalWon(values.interest),
      fee: optionalWon(values.fee), cancelled_interest: Number(values.cancelled_interest), early_fee: Number(values.early_fee)});}}>
      <fieldset className="installment-form" disabled={disabled}>
        <label>명세서 기준일<input type="date" required min={purchaseDate} max={todayIso()} value={day} onChange={e=>setDay(e.target.value)}/></label>
        {([["interest","명세서 이자"],["fee","명세서 수수료"],["cancelled_interest","취소된 미래 이자"],["early_fee","추가 중도상환 수수료"]] as const).map(([key,label]) =>
          <label key={key}>{label}<input type="number" min="0" value={values[key]} placeholder="미확인" onChange={e => setValues({...values,[key]:e.target.value})}/></label>)}
        <button className="btn secondary">회차 명세서 저장</button>
      </fieldset>
    </form>
  </details>;
}
