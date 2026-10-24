"""Installment aggregate: purchase -> principal rows <- actual payment/refund.

One IMMEDIATE transaction owns validation, writes, revision and retry receipt.
Read models batch allocations; projections use settlements at their fork date.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json

from moneymap.app_services.scenarios import now
from moneymap.domain import Money, Posting, Transaction
from moneymap.domain.errors import (
    DomainConflictError,
    DomainNotFoundError,
    DomainValidationError,
)
from moneymap.domain.installments import schedule
from moneymap.domain.projection import ProjectionEvent
from moneymap.domain.services import validate_postable_accounts
from .accounts import SqliteAccountRepository
from .common import _account_write
from .transactions import _insert_txn


def revision(conn):
    return conn.execute(
        "SELECT installment_revision FROM calculation_revisions WHERE id=1"
    ).fetchone()[0]


def mutate(conn, command, action, target, apply):
    payload = json.dumps(
        [action, target, command.model_dump(mode="json")], sort_keys=True
    )
    fingerprint = hashlib.sha256(payload.encode()).hexdigest()
    with _account_write(conn):
        receipt = conn.execute(
            "SELECT * FROM installment_requests WHERE request_id=?",
            (str(command.request_id),),
        ).fetchone()
        if receipt:
            if receipt["fingerprint"] != fingerprint:
                raise DomainConflictError(
                    "재시도 내용이 달라졌습니다. 최신 목록을 확인하세요",
                    code="installment_request_conflict",
                )
            return json.loads(receipt["result"])
        if revision(conn) != command.expected_revision:
            raise DomainConflictError(
                "할부 내역이 변경됐습니다. 최신 목록을 확인한 뒤 다시 저장하세요",
                code="installment_revision_conflict",
            )
        result = apply() or {}
        conn.execute(
            "UPDATE calculation_revisions SET installment_revision=installment_revision+1 WHERE id=1"
        )
        result["revision"] = revision(conn)
        result["request_id"] = str(command.request_id)
        conn.execute(
            "INSERT INTO installment_requests VALUES(?,?,?)",
            (str(command.request_id), fingerprint, json.dumps(result)),
        )
        return result


def _require_plan(conn, plan_id):
    row = conn.execute(
        "SELECT p.*,t.date purchase_date FROM installment_plans p JOIN transactions t ON t.id=p.purchase_id WHERE p.id=?",
        (plan_id,),
    ).fetchone()
    if row is None:
        raise DomainNotFoundError("할부 일정이 없습니다", code="installment_not_found")
    return row


def create(conn, command):
    def apply():
        if command.date > now().date():
            raise DomainValidationError("구매일은 오늘 또는 과거여야 합니다")
        accounts = SqliteAccountRepository(conn).find_all()
        ids = {
            command.debit_account_id,
            command.card_account_id,
            command.cash_account_id,
        }
        validate_postable_accounts(accounts, list(ids))
        by_id = {a.id: a for a in accounts}
        for account_id in ids:
            a = by_id.get(account_id)
            if a is None or a.archived or a.is_system or a.currency != "KRW":
                raise DomainValidationError("사용 가능한 원화 말단 계정을 선택하세요")
        if (
            by_id[command.card_account_id].type.value != "liability"
            or by_id[command.cash_account_id].type.value != "asset"
            or by_id[command.debit_account_id].type.value not in {"asset", "expense"}
        ):
            raise DomainValidationError(
                "구매는 비용/자산, 카드는 부채, 납부 통장은 자산 계정을 선택하세요"
            )
        if command.debit_account_id == command.cash_account_id:
            raise DomainValidationError(
                "구매 자산과 납부 통장은 다른 계정을 선택하세요"
            )
        txn = Transaction(
            scenario_id=1,
            date=command.date,
            description=command.description.strip(),
            postings=[
                Posting(
                    account_id=command.debit_account_id,
                    amount=Money(amount=command.principal),
                ),
                Posting(
                    account_id=command.card_account_id,
                    amount=Money(amount=-command.principal),
                ),
            ],
        )
        purchase_id = _insert_txn(conn, txn)
        plan_id = conn.execute(
            "INSERT INTO installment_plans(purchase_id,debit_account_id,card_account_id,cash_account_id,principal,exclude_from_spend) VALUES(?,?,?,?,?,?)",
            (
                purchase_id,
                command.debit_account_id,
                command.card_account_id,
                command.cash_account_id,
                command.principal,
                int(command.exclude_from_spend),
            ),
        ).lastrowid
        conn.executemany(
            "INSERT INTO installments(plan_id,number,due_date,principal) VALUES(?,?,?,?)",
            [
                (plan_id, row["number"], row["due_date"], row["principal"])
                for row in schedule(
                    command.principal, command.months, command.first_due_date
                )
            ],
        )
        return {"id": plan_id, "purchase_id": purchase_id}

    return mutate(conn, command, "create", None, apply)


def rule_context(plan, rules, rows):
    # Any cash->same card rule in the schedule window could include this purchase.
    # Include rules from other cash accounts: card bills may move between banks.
    remaining = [r for r in rows if r["remaining"] > 0]
    candidates = [
        r
        for r in rules
        if r.to_account_id == plan["card_account_id"]
        and remaining
        and r.start_date.isoformat() <= max(x["due_date"] for x in remaining)
        and (
            r.end_date is None
            or r.end_date.isoformat() >= min(x["due_date"] for x in remaining)
        )
    ]
    serialized = [
        r.model_dump(mode="json", exclude={"last_materialized"}) for r in candidates
    ]
    signature = hashlib.sha256(
        json.dumps(serialized, sort_keys=True).encode()
    ).hexdigest()
    return candidates, signature


def read_plans(conn, as_of=None):
    """Three bounded-by-data batch reads, independent of the number of plans."""
    as_of = as_of or now().date()
    plans = [
        dict(r)
        for r in conn.execute(
            "SELECT p.*,t.description,t.date purchase_date FROM installment_plans p JOIN transactions t ON t.id=p.purchase_id ORDER BY p.id DESC"
        )
    ]
    if not plans:
        return []
    rows = [
        dict(r)
        for r in conn.execute(
            "SELECT i.*,coalesce(sum(CASE WHEN t.date<=? THEN a.amount ELSE 0 END),0) settled FROM installments i LEFT JOIN installment_allocations a ON a.installment_id=i.id LEFT JOIN transactions t ON t.id=a.transaction_id GROUP BY i.id ORDER BY i.plan_id,i.number",
            (as_of.isoformat(),),
        )
    ]
    allocations = [
        dict(r)
        for r in conn.execute(
            "SELECT a.*,t.date,t.description FROM installment_allocations a JOIN transactions t ON t.id=a.transaction_id ORDER BY t.date,t.id"
        )
    ]
    by_plan = {}
    for row in rows:
        row["remaining"] = row["principal"] - row["settled"]
        row["status"] = (
            "paid"
            if row["remaining"] == 0
            else "needs_confirmation"
            if row["due_date"] <= as_of.isoformat()
            else "scheduled"
        )
        by_plan.setdefault(row["plan_id"], []).append(row)
    for p in plans:
        p["installments"] = by_plan.get(p["id"], [])
        row_ids = {r["id"] for r in p["installments"]}
        p["allocations"] = [a for a in allocations if a["installment_id"] in row_ids]
        p["remaining_principal"] = sum(r["remaining"] for r in p["installments"])
        outstanding = [r for r in p["installments"] if r["remaining"]]
        p["next_due_date"] = min((r["due_date"] for r in outstanding), default=None)
        p["completion_date"] = max((r["due_date"] for r in outstanding), default=None)
    return plans


def uncovered_plans(plans, rules):
    """Included installments must fit the bills on the same date and bank/card pair.

    Sum across purchases before comparing: one 200k bill cannot cover two 200k
    installments just because each purchase separately fits that bill.
    """
    groups = {}
    for p in plans:
        if p["projection_mode"] != "included":
            continue
        for row in p["installments"]:
            if row["remaining"]:
                key = (row["due_date"], p["cash_account_id"], p["card_account_id"])
                group = groups.setdefault(key, {"amount": 0, "ids": set()})
                group["amount"] += row["remaining"]
                group["ids"].add(p["id"])
    uncovered = set()
    for (date, cash, card), group in groups.items():
        day = dt.date.fromisoformat(date)
        capacity = sum(
            r.amount.amount
            for r in rules
            if r.from_account_id == cash
            and r.to_account_id == card
            and r.start_date <= day <= (r.end_date or day)
            and next(r.schedule.occurrences(day, day), None) is not None
        )
        if capacity < group["amount"]:
            uncovered.update(group["ids"])
    return uncovered


def list_plans(conn):
    from .rules import ScenarioRuleWriter

    rules = ScenarioRuleWriter(conn).find_by_scenario(1)
    plans = read_plans(conn)
    uncovered = uncovered_plans(plans, rules)
    for p in plans:
        candidates, signature = rule_context(p, rules, p["installments"])
        p["current_rule_signature"] = signature
        p["conflicting_rules"] = [
            {"id": r.id, "description": r.description, "amount": r.amount.amount}
            for r in candidates
        ]
        p["needs_projection_decision"] = bool(candidates) and (
            p["projection_mode"] == "pending" or signature != p["rule_signature"]
        )
        if p["id"] in uncovered or (
            p["projection_mode"] == "included"
            and not candidates
            and p["remaining_principal"]
        ):
            p["needs_projection_decision"] = True
    return {
        "revision": revision(conn),
        "as_of": now().date().isoformat(),
        "plans": plans,
    }


def allocate(conn, command):
    def apply():
        txn = conn.execute(
            "SELECT * FROM transactions WHERE id=? AND scenario_id=1 AND posted=1",
            (command.transaction_id,),
        ).fetchone()
        if txn is None:
            raise DomainNotFoundError(
                "실제 납부/환불 거래가 없습니다", code="transaction_not_found"
            )
        if txn["date"] > now().date().isoformat():
            raise DomainValidationError("미래 거래를 실제 납부로 확인할 수 없습니다")
        if conn.execute(
            "SELECT 1 FROM installment_plans WHERE purchase_id=?",
            (command.transaction_id,),
        ).fetchone():
            raise DomainValidationError(
                "구매 거래 자체를 납부/환불로 배분할 수 없습니다"
            )
        postings = conn.execute(
            "SELECT account_id,amount,currency FROM postings WHERE txn_id=?",
            (command.transaction_id,),
        ).fetchall()
        if any(p["currency"] != "KRW" for p in postings):
            raise DomainValidationError("원화 거래만 연결할 수 있습니다")
        amounts = {}
        for p in postings:
            amounts[p["account_id"]] = amounts.get(p["account_id"], 0) + p["amount"]
        conn.execute(
            "DELETE FROM installment_allocations WHERE transaction_id=?",
            (command.transaction_id,),
        )
        used_debit, used_credit = {}, {}
        for allocation in command.allocations:
            row = conn.execute(
                "SELECT i.*,p.card_account_id,p.cash_account_id,p.debit_account_id,t.date purchase_date FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN transactions t ON t.id=p.purchase_id WHERE i.id=?",
                (allocation.installment_id,),
            ).fetchone()
            if row is None:
                raise DomainNotFoundError(
                    "회차가 없습니다", code="installment_not_found"
                )
            if txn["date"] < row["purchase_date"]:
                raise DomainValidationError("구매일 이전 거래는 연결할 수 없습니다")
            settled = conn.execute(
                "SELECT coalesce(sum(amount),0) FROM installment_allocations WHERE installment_id=?",
                (allocation.installment_id,),
            ).fetchone()[0]
            if settled + allocation.amount > row["principal"]:
                raise DomainValidationError("배분액이 회차의 남은 원금을 넘습니다")
            debit = row["card_account_id"]
            credit = (
                row["cash_account_id"]
                if command.kind == "payment"
                else row["debit_account_id"]
            )
            used_debit[debit] = used_debit.get(debit, 0) + allocation.amount
            used_credit[credit] = used_credit.get(credit, 0) + allocation.amount
            if used_debit[debit] > amounts.get(debit, 0) or used_credit[
                credit
            ] > -amounts.get(credit, 0):
                raise DomainValidationError(
                    "배분 합계가 거래의 카드 상환액 또는 상대 계정 금액을 넘습니다. 납부는 통장→카드, 환불은 구매 계정→카드 거래를 선택하세요"
                )
            conn.execute(
                "INSERT INTO installment_allocations VALUES(?,?,?,?)",
                (
                    command.transaction_id,
                    allocation.installment_id,
                    command.kind,
                    allocation.amount,
                ),
            )
        return {"transaction_id": command.transaction_id}

    return mutate(conn, command, "allocate", command.transaction_id, apply)


def update_plan(conn, plan_id, command):
    def apply():
        from .rules import ScenarioRuleWriter

        plans = read_plans(conn)
        plan = next((p for p in plans if p["id"] == plan_id), None)
        if plan is None:
            raise DomainNotFoundError(
                "할부 일정이 없습니다", code="installment_not_found"
            )
        rules = ScenarioRuleWriter(conn).find_by_scenario(1)
        candidates, signature = rule_context(plan, rules, plan["installments"])
        if signature != command.rule_signature:
            raise DomainConflictError(
                "반복 규칙이 변경됐습니다. 목록을 새로 확인하세요",
                code="installment_rules_changed",
            )
        if command.projection_mode == "included" and not candidates:
            raise DomainValidationError("포함할 카드 납부 반복 규칙이 없습니다")
        plan["projection_mode"] = command.projection_mode
        if plan_id in uncovered_plans(plans, rules):
            raise DomainValidationError(
                "반복 규칙의 납부일·통장·금액이 할부 잔액을 모두 포함하지 않습니다. 예정일과 규칙을 확인하세요"
            )
        conn.execute(
            "UPDATE installment_plans SET projection_mode=?,rule_signature=? WHERE id=?",
            (command.projection_mode, signature, plan_id),
        )

    return mutate(conn, command, "update", plan_id, apply)


def reschedule(conn, row_id, command):
    def apply():
        row = conn.execute(
            "SELECT i.*,t.date purchase_date FROM installments i JOIN installment_plans p ON p.id=i.plan_id JOIN transactions t ON t.id=p.purchase_id WHERE i.id=?",
            (row_id,),
        ).fetchone()
        if row is None:
            raise DomainNotFoundError("회차가 없습니다", code="installment_not_found")
        if conn.execute(
            "SELECT 1 FROM installment_allocations WHERE installment_id=?", (row_id,)
        ).fetchone():
            raise DomainConflictError(
                "납부/환불 연결이 있는 회차입니다. 배분을 해제한 뒤 날짜를 조정하세요"
            )
        if command.due_date.isoformat() < row["purchase_date"]:
            raise DomainValidationError("납부 예정일은 구매일 이후여야 합니다")
        conn.execute(
            "UPDATE installments SET due_date=? WHERE id=?",
            (command.due_date.isoformat(), row_id),
        )
        # A date change may change which bills cover this purchase.
        conn.execute(
            "UPDATE installment_plans SET projection_mode='pending',rule_signature='' WHERE id=?",
            (row["plan_id"],),
        )

    return mutate(conn, command, "reschedule", row_id, apply)


def remove(conn, plan_id, command):
    def apply():
        _require_plan(conn, plan_id)
        if conn.execute(
            "SELECT 1 FROM installment_allocations a JOIN installments i ON i.id=a.installment_id WHERE i.plan_id=?",
            (plan_id,),
        ).fetchone():
            raise DomainConflictError(
                "납부/환불 배분을 모두 해제한 뒤 일정을 삭제하세요"
            )
        conn.execute("DELETE FROM installment_plans WHERE id=?", (plan_id,))

    return mutate(conn, command, "remove", plan_id, apply)


def projection_inputs(conn, fork, rules):
    events, warnings = [], []
    # Purchases outside the opening balance must not consume historical bill capacity.
    plans = [
        p for p in read_plans(conn, fork) if p["purchase_date"] <= fork.isoformat()
    ]
    uncovered = uncovered_plans(plans, rules)
    for p in plans:
        rows = p["installments"]
        candidates, signature = rule_context(p, rules, rows)
        undecided = bool(candidates) and (
            p["projection_mode"] == "pending" or signature != p["rule_signature"]
        )
        if p["id"] in uncovered or (
            p["projection_mode"] == "included" and not candidates
        ):
            undecided = True
        if undecided and p["remaining_principal"]:
            warnings.append(
                f"{p['description']}: 카드값 반복 규칙과 중복 여부를 확인해야 합니다. 할부 예정액은 전망에서 보류했습니다."
            )
        for row in rows:
            remaining = row["remaining"]
            if not remaining:
                continue
            if row["due_date"] <= fork.isoformat():
                warnings.append(
                    f"{p['description']} {row['number']}회차: 납부 확인 또는 예정일 조정이 필요합니다. 현금 전망에 미확인 금액이 빠져 있습니다."
                )
                continue
            if undecided or p["projection_mode"] == "included":
                continue
            events.append(
                ProjectionEvent(
                    dt.date.fromisoformat(row["due_date"]),
                    "installment",
                    row["id"],
                    f"{p['description']} {row['number']}회차",
                    "actual",
                    (
                        (p["cash_account_id"], -remaining),
                        (p["card_account_id"], remaining),
                    ),
                )
            )
    return tuple(events), tuple(dict.fromkeys(warnings))


def candidates(conn, query):
    """User searches existing actual transactions; IDs are never guessed by amount."""
    rows = conn.execute(
        "SELECT t.id,t.date,t.description,p.account_id,p.amount FROM (SELECT * FROM transactions WHERE scenario_id=1 AND posted=1 AND date<=? AND (instr(description,?)>0 OR CAST(id AS TEXT)=?) ORDER BY date DESC,id DESC LIMIT 100) t JOIN postings p ON p.txn_id=t.id ORDER BY t.date DESC,t.id DESC,p.id",
        (now().date().isoformat(), query, query),
    ).fetchall()
    result = {}
    for row in rows:
        item = result.setdefault(
            row["id"],
            {
                "id": row["id"],
                "date": row["date"],
                "description": row["description"],
                "postings": [],
            },
        )
        item["postings"].append(
            {"account_id": row["account_id"], "amount": row["amount"]}
        )
    return list(result.values())
