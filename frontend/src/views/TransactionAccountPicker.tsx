import { useEffect, useId, useMemo, useState } from "react";
import { accountTree, type Account, type AccountType } from "../api";

const TYPES: [AccountType, string][] = [["asset", "자산"], ["liability", "부채"], ["income", "수익"], ["expense", "비용"], ["equity", "자본"]];
type Node = { key: string; name: string; account?: Account; children: Node[] };
export function accountPickerModel(accounts: Account[]) {
  const ordered = accountTree(accounts);
  const byId = new Map(accounts.map(a => [a.id, a]));
  const parents = new Set(accounts.map(a => a.parent_id));
  const available = new Set(ordered.map(row => row.account).filter(a => !a.archived && !a.is_placeholder && !a.is_system && !parents.has(a.id)).map(a => a.id));
  const roots: Node[] = TYPES.map(([key, name]) => ({ key, name, children: [] }));
  const nodes = new Map<string, Node>(roots.map(n => [n.key, n]));
  const paths = new Map<number, string>();
  const ancestors = new Map<number, string[]>();
  for (const { account } of ordered) {
    const node: Node = { key: String(account.id), name: account.name, account, children: [] };
    const parent = nodes.get(String(account.parent_id)) ?? nodes.get(account.type)!;
    parent.children.push(node);
    nodes.set(node.key, node);
    const trail = account.parent_id === null ? [account.type] : [...(ancestors.get(account.parent_id) ?? [account.type]), String(account.parent_id)];
    ancestors.set(account.id, trail);
    paths.set(account.id, [...trail.map(k => nodes.get(k)!.name), account.name].join(" > "));
  }
  return { byId, available, roots, nodes, paths, ancestors };
}
export type AccountPickerModel = ReturnType<typeof accountPickerModel>;

export function TransactionAccountPicker({ model, label, value, onSelect }: {
  model: AccountPickerModel; label: string; value: number | null; onSelect: (id: number) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(matchMedia("(max-width:720px)").matches ? [] : model.nodes.keys()));
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width:720px)").matches);
  useEffect(() => {
    const media = matchMedia("(max-width:720px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    setOpen(previous => new Set([...previous, ...(!narrow ? model.nodes.keys() : value === null ? [] : model.ancestors.get(value) ?? [])]));
  }, [model, value, narrow]);
  const query = search.normalize("NFC").trim().toLocaleLowerCase();
  const matches = useMemo(() => new Set([...model.available].filter(aid => model.paths.get(aid)!.normalize("NFC").toLocaleLowerCase().includes(query))), [model, query]);
  const visible = [...matches].filter(aid => query || model.ancestors.get(aid)!.every(key => open.has(key)));
  const entry = value !== null && visible.includes(value) ? value : visible[0];
  const hasMatch = (node: Node): boolean => node.account && model.available.has(node.account.id)
    ? matches.has(node.account.id) : node.children.some(hasMatch);
  const render = (node: Node): React.ReactNode => {
    if (!hasMatch(node)) return null;
    const a = node.account;
    if (a && model.available.has(a.id)) return <label className="account-choice" key={node.key}>
      <input type="radio" name={id} aria-label={model.paths.get(a.id)} checked={value === a.id}
        tabIndex={entry === a.id ? 0 : -1}
        onChange={() => onSelect(a.id)} onClick={() => { if (value === a.id) onSelect(a.id); }}
        onKeyDown={event => {
          if (event.key === "Enter") { event.preventDefault(); onSelect(a.id); }
          if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
            event.preventDefault();
            const direction = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1;
            const next = visible[(visible.indexOf(a.id) + direction + visible.length) % visible.length];
            const group = event.currentTarget.closest("[role=group]")!;
            const target = [...group.querySelectorAll<HTMLInputElement>("input[type=radio]")].find(input => input.dataset.account === String(next));
            target?.focus(); onSelect(next);
          }
        }} data-account={a.id} />
      <span className="account-check" aria-hidden="true">✓</span><span>{a.name}</span>
    </label>;
    return <details className="account-group" key={node.key} open={!!query || open.has(node.key)}
      onToggle={event => {
        if (query) return;
        const expanded = event.currentTarget.open;
        setOpen(previous => {
          if (previous.has(node.key) === expanded) return previous;
          const next = new Set(previous); if (expanded) next.add(node.key); else next.delete(node.key); return next;
        });
      }}>
      <summary>{node.name}</summary><div className="account-choices">{node.children.map(render)}</div>
    </details>;
  };
  return <div role="group" aria-label={label} className="account-picker">
    <label className="picker-search-label" htmlFor={`${id}-search`}>{label} 검색</label>
    <input id={`${id}-search`} type="search" placeholder="계정 이름 또는 경로" value={search} onChange={e => setSearch(e.target.value)} />
    <div className="account-groups">{model.roots.map(render)}</div>
    {matches.size === 0 && <div className="picker-empty" role="status"><p>{model.available.size ? "검색 결과가 없습니다." : "선택할 계정이 없습니다."}</p>
      {search && <button type="button" className="btn secondary" onClick={() => { setSearch(""); document.getElementById(`${id}-search`)?.focus(); }}>검색어 지우기</button>}
    </div>}
  </div>;
}
