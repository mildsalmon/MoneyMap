import { useEffect, useRef, useState } from "react";
import { Check, Pencil, Plus, X } from "lucide-react";
import {
  accountTree,
  api,
  isGroup,
  isPostable,
  withDescendants,
  type Account,
  type AccountType,
  type BalanceRow,
  type Txn,
} from "../api";
import { commaInput, fmtWon, todayIso } from "../format";
import type { ViewProps } from "../App";

const TYPE_LABEL: Record<AccountType, string> = {
  asset: "자산",
  liability: "부채",
  income: "수익",
  expense: "비용",
  equity: "자본",
};

const DISPLAY_TYPES: AccountType[] = ["asset", "liability", "income", "expense"];

export function Accounts({ gen, refresh, showToast }: ViewProps) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [balances, setBalances] = useState<BalanceRow[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("asset");
  const [parentId, setParentId] = useState<number | "">("");
  const [openInput, setOpenInput] = useState<Record<number, string>>({});
  const [rootDraft, setRootDraft] = useState<{ type: AccountType; name: string } | null>(null);
  const [childDraft, setChildDraft] = useState<{ parentId: number; name: string } | null>(null);
  const [editDraft, setEditDraft] = useState<{ id: number; name: string } | null>(null);
  const [reclassTargets, setReclassTargets] = useState<Record<number, number | "">>({});
  const [err, setErr] = useState("");
  const [txns, setTxns] = useState<Txn[]>([]);
  const inlineRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.accounts().then(setAccounts);
    api.balances().then((b) => setBalances(b.accounts));
    api.transactions().then(setTxns);
  }, [gen]);

  useEffect(() => {
    inlineRef.current?.focus();
  }, [rootDraft?.type, childDraft?.parentId, editDraft?.id]);

  const opening = accounts.find((a) => a.is_system && a.type === "equity");
  const visible = accounts.filter((a) => !a.is_system && !a.archived);
  const archivedList = accounts.filter((a) => !a.is_system && a.archived);
  const balanceOf = (id: number) => balances.find((b) => b.account_id === id);

  const displayAmount = (a: Account, raw: number) => (a.type === "income" ? -raw : raw);

  const create = async () => {
    setErr("");
    try {
      await api.createAccount({ name: name.trim(), type, parent_id: parentId === "" ? null : parentId });
      setName("");
      setParentId("");
      refresh();
      showToast(`계정 "${name.trim()}" 생성됨`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const createRoot = async (rootType: AccountType) => {
    const draftName = rootDraft?.type === rootType ? rootDraft.name.trim() : "";
    if (!draftName) return;
    setErr("");
    try {
      await api.createAccount({ name: draftName, type: rootType, parent_id: null });
      setRootDraft({ type: rootType, name: "" });
      refresh();
      showToast(`${TYPE_LABEL[rootType]} "${draftName}" 생성됨`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const createChild = async (parent: Account) => {
    const draftName = childDraft?.parentId === parent.id ? childDraft.name.trim() : "";
    if (!draftName) return;
    setErr("");
    try {
      await api.createAccount({ name: draftName, type: parent.type, parent_id: parent.id });
      setChildDraft({ parentId: parent.id, name: "" });
      refresh();
      showToast(`"${parent.name}" 아래 "${draftName}" 생성됨`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const seedStandard = async () => {
    setErr("");
    try {
      const seeded = await api.seedStandardAccounts();
      refresh();
      showToast(
        seeded.created > 0
          ? `표준 계정과목 ${seeded.created}개 추가됨`
          : "표준 계정과목이 이미 모두 있습니다",
      );
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const reclassifyDirect = async (a: Account) => {
    const target = reclassTargets[a.id];
    if (target === undefined || target === "") return;
    setErr("");
    try {
      const result = await api.reclassifyDirect(a.id, target);
      setReclassTargets((s) => ({ ...s, [a.id]: "" }));
      refresh();
      showToast(`"${a.name}" 미분류 ${result.moved_postings}건 이동됨`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  const startRename = (a: Account) => {
    setErr("");
    setRootDraft(null);
    setChildDraft(null);
    setEditDraft({ id: a.id, name: a.name });
  };

  const saveRename = async (a: Account) => {
    const draftName = editDraft?.id === a.id ? editDraft.name.trim() : "";
    if (!draftName) return;
    setErr("");
    try {
      await api.updateAccount(a.id, { name: draftName });
      setEditDraft(null);
      refresh();
      showToast(`"${a.name}" → "${draftName}" 이름 변경됨`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  // 계정 보관 (소프트 삭제, D23) — 잔액이 남아 있으면 경고 후 진행
  const archive = async (a: Account) => {
    const bal = balanceOf(a.id)?.balance ?? 0;
    if (bal !== 0 && !window.confirm(
      `"${a.name}"에 잔액 ${fmtWon(bal)}이 남아 있습니다.\n` +
      "회계 관습상 이체·조정으로 잔액을 비운 뒤 보관하는 것이 정석입니다.\n그래도 보관할까요?",
    )) return;
    try {
      await api.archiveAccount(a.id);
      refresh();
      showToast(`"${a.name}" 보관됨 — 아래 보관된 계정에서 복원할 수 있습니다`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  // 개시잔액은 계정당 1회 — 이미 개시 거래(자본:개시잔액 상대)가 있는 계정은 잠근다.
  const openedIds = new Set(
    txns
      .filter((t) => opening && t.postings.some((p) => p.account_id === opening.id))
      .flatMap((t) => t.postings.map((p) => p.account_id)),
  );

  // 0원 확인: 0원은 거래를 만들 수 없으므로(도메인 규칙) "확인했음" 표시만 저장
  const [zeroConfirmed, setZeroConfirmed] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("moneymap.opening_zero") ?? "[]");
    } catch {
      return [];
    }
  });
  const setZero = (ids: number[]) => {
    setZeroConfirmed(ids);
    localStorage.setItem("moneymap.opening_zero", JSON.stringify(ids));
  };

  // 그룹(대분류) 전환/해제 (D24) — 백엔드가 "이미 거래 있으면 그룹 전환 차단" 가드
  const toggleGroup = async (a: Account) => {
    setErr("");
    try {
      await api.setPlaceholder(a.id, !a.is_placeholder);
      refresh();
      showToast(a.is_placeholder ? `"${a.name}" 일반 계정으로` : `"${a.name}" 그룹(대분류)으로 — 하위 계정을 만들어 쓰세요`);
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  // 개시잔액 = 자본:개시잔액 상대 거래 (D4). equity 계정은 자동·숨김.
  const recordOpening = async (acc: Account) => {
    const { value } = commaInput(openInput[acc.id] ?? "");
    if (!opening) return;
    if (value === 0) {
      setZero([...zeroConfirmed, acc.id]);
      setOpenInput((s) => ({ ...s, [acc.id]: "" }));
      refresh();
      showToast(`${acc.name} — 0원으로 확인됨 (기록할 거래 없음)`);
      return;
    }
    const sign = acc.type === "liability" ? -1 : 1; // 부채 잔액은 대변(−)
    const txn = await api.createTransaction({
      date: todayIso(),
      description: `개시잔액: ${acc.name}`,
      postings: [
        { account_id: acc.id, amount: sign * value },
        { account_id: opening.id, amount: -sign * value },
      ],
    });
    setOpenInput((s) => ({ ...s, [acc.id]: "" }));
    refresh();
    showToast(`개시잔액 기록됨 · ${acc.name} ${fmtWon(sign * value)}`, async () => {
      await api.deleteTransaction(txn.id);
      refresh();
    });
  };

  const renderRootDraft = (sectionType: AccountType) => {
    if (rootDraft?.type !== sectionType) return null;
    return (
      <tr className="account-inline" key={`root-${sectionType}`}>
        <td>
          <input
            ref={inlineRef}
            aria-label={`${TYPE_LABEL[sectionType]} 새 분류 이름`}
            value={rootDraft.name}
            onChange={(e) => setRootDraft({ type: sectionType, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") createRoot(sectionType);
              if (e.key === "Escape") setRootDraft(null);
            }}
            placeholder="이름"
            style={{ width: 180, padding: "5px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
          />
        </td>
        <td><span className="badge">{TYPE_LABEL[sectionType]}</span></td>
        <td />
        <td />
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="btn sm primary" disabled={!rootDraft.name.trim()} onClick={() => createRoot(sectionType)}>저장</button>{" "}
          <button className="btn sm secondary" onClick={() => setRootDraft(null)}>취소</button>
        </td>
      </tr>
    );
  };

  const renderChildDraft = (parent: Account, depth: number) => {
    if (childDraft?.parentId !== parent.id) return null;
    return (
      <tr className="account-inline" key={`child-${parent.id}`}>
        <td style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          <span style={{ color: "var(--faint)" }}>└ </span>
          <input
            ref={inlineRef}
            aria-label={`${parent.name} 소분류 이름`}
            value={childDraft.name}
            onChange={(e) => setChildDraft({ parentId: parent.id, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") createChild(parent);
              if (e.key === "Escape") setChildDraft(null);
            }}
            placeholder="이름"
            style={{ width: 170, padding: "5px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
          />
        </td>
        <td><span className="badge">{TYPE_LABEL[parent.type]}</span></td>
        <td />
        <td />
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="btn sm primary" disabled={!childDraft.name.trim()} onClick={() => createChild(parent)}>저장</button>{" "}
          <button className="btn sm secondary" onClick={() => setChildDraft(null)}>취소</button>
        </td>
      </tr>
    );
  };

  const renderUnclassified = (a: Account, depth: number) => {
    const raw = balanceOf(a.id)?.balance ?? 0;
    if (raw === 0) return null;
    const targets = visible.filter((c) => c.parent_id === a.id && isPostable(accounts, c));
    const target = reclassTargets[a.id] ?? "";
    return (
      <tr key={`unclassified-${a.id}`} style={{ color: "var(--muted)" }}>
        <td style={{ paddingLeft: 8 + (depth + 1) * 20 }}>
          <span style={{ color: "var(--faint)" }}>└ </span>(미분류)
        </td>
        <td><span className="badge">직접 기장</span></td>
        <td className="num">{fmtWon(displayAmount(a, raw))}</td>
        <td />
        <td style={{ whiteSpace: "nowrap" }}>
          <select
            aria-label={`${a.name} 미분류 이동 대상`}
            value={target}
            disabled={targets.length === 0}
            onChange={(e) => setReclassTargets((s) => ({ ...s, [a.id]: e.target.value === "" ? "" : Number(e.target.value) }))}
            style={{ maxWidth: 140, marginRight: 6, padding: "3px 6px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
          >
            <option value="">대상</option>
            {targets.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className="btn sm secondary" disabled={target === ""} onClick={() => reclassifyDirect(a)}>
            소분류로 이동
          </button>
        </td>
      </tr>
    );
  };

  const renderAccountRow = (a: Account, depth: number) => {
    const isNW = a.type === "asset" || a.type === "liability";
    const hasChildren = accounts.some((c) => c.parent_id === a.id);
    const hasVisibleChildren = visible.some((c) => c.parent_id === a.id);
    const group = isGroup(accounts, a);
    const rollupIds = hasVisibleChildren ? withDescendants(visible, a.id) : [a.id];
    const rawSum = rollupIds.reduce((s, id) => s + (balanceOf(id)?.balance ?? 0), 0);
    const shownBalance = displayAmount(a, rawSum);
    const recorded = isNW && openedIds.has(a.id);
    const zeroed = isNW && !recorded && zeroConfirmed.includes(a.id);
    const canOpen = isNW && !group && !recorded && !zeroed;
    const editing = editDraft?.id === a.id;
    return (
      <tr key={a.id} className="account-row" style={group ? { color: "var(--muted)" } : undefined}>
        <td style={{ paddingLeft: 8 + depth * 20 }}>
          {depth > 0 && <span style={{ color: "var(--faint)" }}>└ </span>}
          {editing ? (
            <input
              ref={inlineRef}
              aria-label={`${a.name} 이름`}
              value={editDraft.name}
              onChange={(e) => setEditDraft({ id: a.id, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveRename(a);
                if (e.key === "Escape") setEditDraft(null);
              }}
              style={{ width: 180, padding: "5px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
            />
          ) : (
            a.name
          )}
          {!editing && group && (
            <span className="badge" style={{ marginLeft: 6 }}>
              {hasChildren ? "그룹 · 합산" : "그룹"}
            </span>
          )}
        </td>
        <td><span className="badge">{TYPE_LABEL[a.type]}</span></td>
        <td className="num">{fmtWon(shownBalance)}</td>
        <td className="num">
          {recorded && (
            <span className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              ✓ 기록됨
            </span>
          )}
          {zeroed && (
            <span className="badge" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
              ✓ 기록됨 (0원)
            </span>
          )}
          {canOpen && (
            <input
              className="num"
              style={{ width: 130, padding: "4px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
              placeholder="0"
              value={openInput[a.id] ?? ""}
              onChange={(e) => setOpenInput((s) => ({ ...s, [a.id]: commaInput(e.target.value).display }))}
              onKeyDown={(e) => e.key === "Enter" && recordOpening(a)}
            />
          )}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          {editing ? (
            <>
              <button className="btn sm primary" disabled={!editDraft.name.trim()} onClick={() => saveRename(a)}>
                <Check size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                저장
              </button>{" "}
              <button className="btn sm secondary" onClick={() => setEditDraft(null)}>
                <X size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                취소
              </button>
            </>
          ) : (
            <>
              {canOpen && (
                <button className="btn sm secondary" onClick={() => recordOpening(a)}>
                  기록
                </button>
              )}
              {zeroed && (
                <button className="btn sm secondary" onClick={() => setZero(zeroConfirmed.filter((x) => x !== a.id))}>
                  해제
                </button>
              )}{" "}
              {group && (
                <button
                  className="btn sm secondary"
                  onClick={() => {
                    setChildDraft({ parentId: a.id, name: "" });
                    setRootDraft(null);
                    setEditDraft(null);
                  }}
                  title="소분류 추가"
                >
                  <Plus size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                  소분류
                </button>
              )}{" "}
              {!hasChildren && (
                <button className="btn sm secondary" onClick={() => toggleGroup(a)}>
                  {a.is_placeholder ? "그룹 해제" : "그룹으로"}
                </button>
              )}{" "}
              <button className="btn sm secondary" onClick={() => startRename(a)}>
                <Pencil size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                이름
              </button>
              {" "}
              <button className="btn sm danger" onClick={() => archive(a)}>보관</button>
            </>
          )}
        </td>
      </tr>
    );
  };

  const renderSection = (sectionType: AccountType) => {
    const rows = accountTree(visible.filter((a) => a.type === sectionType));
    const virtualsByAfter = new Map<number, { account: Account; depth: number }[]>();
    rows.forEach(({ account: a, depth }, i) => {
      if (!isGroup(accounts, a) || (balanceOf(a.id)?.balance ?? 0) === 0) return;
      let last = i;
      for (let j = i + 1; j < rows.length && rows[j].depth > depth; j += 1) last = j;
      virtualsByAfter.set(last, [...(virtualsByAfter.get(last) ?? []), { account: a, depth }]);
    });

    const out = [
      <tr className="account-section" key={`section-${sectionType}`}>
        <td colSpan={5} style={{ paddingTop: 14, borderBottomColor: "var(--line-strong)" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 650, color: "var(--muted)", letterSpacing: ".04em" }}>
              {TYPE_LABEL[sectionType]}
            </span>
            <button
              className="btn sm secondary"
              onClick={() => {
                setRootDraft({ type: sectionType, name: "" });
                setChildDraft(null);
                setEditDraft(null);
              }}
            >
              <Plus size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
              새 분류
            </button>
          </div>
        </td>
      </tr>,
      renderRootDraft(sectionType),
    ];

    rows.forEach(({ account: a, depth }, i) => {
      out.push(renderAccountRow(a, depth));
      out.push(renderChildDraft(a, depth));
      const virtuals = (virtualsByAfter.get(i) ?? []).sort((x, y) => y.depth - x.depth);
      for (const v of virtuals) out.push(renderUnclassified(v.account, v.depth));
    });
    return out;
  };

  return (
    <div>
      <h1>계정 · 개시잔액</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        <button className="btn secondary" onClick={seedStandard}>표준 계정과목 추가</button>
        {err && <span className="field"><span className="err">{err}</span></span>}
      </div>

      <details style={{ marginBottom: 18 }}>
        <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 12, fontWeight: 600 }}>고급</summary>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
          <div className="field">
            <label>계정 이름</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: Toss뱅크"
              onKeyDown={(e) => e.key === "Enter" && name.trim() && create()} />
          </div>
          <div className="field">
            <label>유형</label>
            <select value={type} onChange={(e) => { setType(e.target.value as AccountType); setParentId(""); }}>
              {DISPLAY_TYPES.map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t]}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>상위 그룹 (선택)</label>
            <select value={parentId} onChange={(e) => setParentId(e.target.value === "" ? "" : Number(e.target.value))}>
              <option value="">없음 (최상위)</option>
              {accountTree(accounts.filter((a) => a.type === type && !a.is_system && !a.archived)).map(({ account: a, depth }) => (
                <option key={a.id} value={a.id}>{"  ".repeat(depth)}{a.name}</option>
              ))}
            </select>
          </div>
          <button className="btn primary" disabled={!name.trim()} onClick={create}>계정 추가</button>
        </div>
      </details>

      <table className="ledger" style={{ maxWidth: 880 }}>
        <thead>
          <tr>
            <th>계정</th><th>유형</th><th className="num">현재 잔액</th><th className="num">개시잔액 입력</th><th />
          </tr>
        </thead>
        <tbody>
          {DISPLAY_TYPES.flatMap(renderSection)}
        </tbody>
      </table>

      {archivedList.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <h4 style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600, marginBottom: 6, letterSpacing: ".04em" }}>
            보관된 계정 ({archivedList.length})
          </h4>
          <table className="ledger" style={{ maxWidth: 720 }}>
            <tbody>
              {archivedList.map((a) => (
                <tr key={a.id} style={{ color: "var(--muted)" }}>
                  <td>
                    {editDraft?.id === a.id ? (
                      <input
                        ref={inlineRef}
                        aria-label={`${a.name} 이름`}
                        value={editDraft.name}
                        onChange={(e) => setEditDraft({ id: a.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") saveRename(a);
                          if (e.key === "Escape") setEditDraft(null);
                        }}
                        style={{ width: 180, padding: "5px 8px", border: "1px solid var(--line-strong)", borderRadius: 4, background: "var(--surface)" }}
                      />
                    ) : (
                      a.name
                    )}
                  </td>
                  <td><span className="badge">{TYPE_LABEL[a.type]}</span></td>
                  <td className="num">{balanceOf(a.id) ? fmtWon(balanceOf(a.id)!.balance) : "—"}</td>
                  <td style={{ whiteSpace: "nowrap", width: 150 }}>
                    {editDraft?.id === a.id ? (
                      <>
                        <button className="btn sm primary" disabled={!editDraft.name.trim()} onClick={() => saveRename(a)}>
                          <Check size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                          저장
                        </button>{" "}
                        <button className="btn sm secondary" onClick={() => setEditDraft(null)}>
                          <X size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                          취소
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn sm secondary" onClick={() => startRename(a)}>
                          <Pencil size={13} aria-hidden="true" style={{ verticalAlign: "-2px", marginRight: 3 }} />
                          이름
                        </button>{" "}
                        <button className="btn sm secondary" onClick={async () => {
                          try {
                            await api.restoreAccount(a.id);
                            refresh();
                            showToast(`"${a.name}" 복원됨`);
                          } catch (e) {
                            setErr(String((e as Error).message));
                          }
                        }}>복원</button>
                      </>
                    )}
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
