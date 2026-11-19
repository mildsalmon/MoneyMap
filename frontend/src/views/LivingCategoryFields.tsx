import { useState } from "react";
import { livingCategories } from "../api/livingCategories";
import { useQuery } from "./scenarios/useQuery";

export function useLivingCategories() {
  return useQuery("living-categories", livingCategories.list);
}
type Catalog = ReturnType<typeof useLivingCategories>;

export function CategorySelect({ label, value, catalog, change }: {
  label: string; value?: number | null; catalog: Catalog; change: (value: number | null) => void;
}) {
  return <label className="field">{label}
    <select value={value ?? ""} disabled={!catalog.data} onChange={event => change(Number(event.target.value) || null)}>
      <option value="">미분류</option>
      {value && !catalog.data?.some(category => category.id === value) && <option value={value}>생활 분류 #{value}</option>}
      {catalog.data?.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select>
  </label>;
}

export function CategoryManager({ catalog }: { catalog: Catalog }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const category = await livingCategories.save(name, selected);
      setNotice(`${category.name} 분류를 저장했습니다.`);
      setSelected(null); setName(""); catalog.reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally { setBusy(false); }
  }
  return <>
    {catalog.error && <p role="alert">생활 분류를 불러오지 못했습니다. <button className="btn secondary" type="button" onClick={catalog.reload}>분류 다시 불러오기</button></p>}
    <details className="category-manager" onToggle={event => setOpen(event.currentTarget.open)}><summary>생활 분류 관리</summary>
      {open && <fieldset disabled={busy || !catalog.data}>
        <legend>분류 추가 · 이름 변경</legend>
        <label className="field">관리할 분류<select value={selected ?? ""} onChange={event => {
          const id = Number(event.target.value) || null;
          setSelected(id); setName(catalog.data?.find(c => c.id === id)?.name ?? "");
          setNotice(""); setError("");
        }}>
          <option value="">새 분류</option>
          {catalog.data?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label className="field">분류 이름<input value={name} maxLength={50} onChange={event => setName(event.target.value)} /></label>
        <button className="btn secondary" type="button" disabled={!name.trim()} onClick={save}>{selected === null ? "분류 추가" : "분류 이름 변경"}</button>
      </fieldset>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </details>
  </>;
}
