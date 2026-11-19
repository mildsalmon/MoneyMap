import { useState } from "react";
import { api, ApiError, type Account } from "../api";
import type { AccountWrites, SiblingScope } from "./useAccountWrites";

export function useAccountCreation(writes: AccountWrites, applySaved: (rows: Account[]) => void, refresh: () => void) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function create(form: string, scope: SiblingScope, name: string, overdraft: boolean, close: () => void) {
    if (!name.trim()) return;
    const ticket = writes.begin(scope);
    if (ticket === null) return;
    const body = { type: scope.type, parent_id: scope.parent_id, name: name.trim(), is_overdraft: overdraft };
    const storageKey = "moneymap.account-create." + JSON.stringify(body);
    setPending(current => ({ ...current, [form]: true }));
    setErrors(current => ({ ...current, [form]: "" }));
    try {
      // Persist before dispatch: a reload can interrupt the POST or either receipt read.
      const previous = sessionStorage.getItem(storageKey);
      const key = previous ?? crypto.randomUUID();
      if (!previous) sessionStorage.setItem(storageKey, key);
      // A lost reply may hide a committed creation, even if it has since been renamed.
      let account = previous ? await api.accountCreationResult(key) : null;
      if (!account) {
        try {
          account = await api.createAccount({ ...body, request_id: key, parent_versions: writes.parentVersions(scope) });
          if (!account?.id) throw new Error("계정 생성 응답을 확인할 수 없습니다");
        } catch (error) {
          if (error instanceof ApiError && error.status < 500 && error.status !== 408) {
            sessionStorage.removeItem(storageKey);
            throw error;
          }
          account = await api.accountCreationResult(key);
          if (!account) throw new Error("서버에 생성 기록이 없습니다. 다시 저장하세요.");
        }
      }
      if (!writes.holds(ticket)) return;
      sessionStorage.removeItem(storageKey);
      applySaved([account]);
      close();
      refresh();
      writes.success(ticket, `계정 "${account.name}" 생성됨`);
    } catch (error) {
      if (error instanceof ApiError && error.code === "account_parent_stale" && writes.holds(ticket)) refresh();
      if (writes.holds(ticket)) setErrors(current => ({ ...current, [form]: (error as Error).message }));
    } finally {
      if (writes.holds(ticket)) setPending(current => ({ ...current, [form]: false }));
      writes.finish(ticket);
    }
  }
  return { create, errors, pending };
}
