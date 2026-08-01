"""FastAPI 인바운드 어댑터 — HTTP를 도메인 유스케이스로 변환만 한다.

실행 (프론트와 분리, D17-eng):
    uv run uvicorn moneymap.api:app --port 8765
CORS는 Vite dev 서버(5173) 허용 목록 방식.
"""

from __future__ import annotations

import asyncio
import datetime
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError

from moneymap import app_services
from moneymap.adapters.sqlite import (
    SqliteAccountRepository,
    SqliteLedgerQueries,
    SqliteRecurringRuleRepository,
    SqliteScenarioRepository,
    SqliteTransactionRepository,
    connect,
    init_db,
)
from moneymap.adapters.sqlite.backup import run_daily_backup
from moneymap.adapters.sqlite.repositories import apply_materialization
from moneymap.domain import (
    ACTUAL_SCENARIO_ID,
    Account,
    AccountType,
    DomainError,
    Money,
    Posting,
    RecurringRule,
    Schedule,
    Transaction,
)
from moneymap.domain.materialize import plan_materialization
from moneymap.domain.services import validate_account_placement
from moneymap.domain.standard_accounts import STANDARD_ACCOUNTS, StandardAccount

DEFAULT_DB = os.environ.get("MONEYMAP_DB", "moneymap.db")
CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


# ─── 요청 스키마 ─────────────────────────────────────────

class AccountIn(BaseModel):
    name: str
    type: AccountType
    parent_id: int | None = None
    is_placeholder: bool = False


class AccountPatchIn(BaseModel):
    name: str


class PlaceholderIn(BaseModel):
    is_placeholder: bool


class PostingIn(BaseModel):
    account_id: int
    amount: int  # KRW 정수, +차변/−대변


class TransactionIn(BaseModel):
    scenario_id: int = ACTUAL_SCENARIO_ID
    date: datetime.date
    description: str = ""
    postings: list[PostingIn]


class RuleIn(BaseModel):
    scenario_id: int = ACTUAL_SCENARIO_ID
    description: str = ""
    from_account_id: int
    to_account_id: int
    amount: int  # 양수
    schedule: str  # 'monthly:25' 등
    start_date: datetime.date
    end_date: datetime.date | None = None


class ScenarioIn(BaseModel):
    name: str
    fork_date: datetime.date  # 기본값(오늘)은 프론트가 채움 (D7-B)


def _account_rule_reference_count(conn, account_id: int) -> int:
    return conn.execute(
        "SELECT COUNT(*) AS n FROM recurring_rules WHERE from_account_id=? OR to_account_id=?",
        (account_id, account_id),
    ).fetchone()["n"]


def _account_referenced_by_rule(conn, account_id: int) -> bool:
    return _account_rule_reference_count(conn, account_id) > 0


def _clean_account_name(name: str) -> str:
    cleaned = name.strip()
    if not cleaned:
        raise HTTPException(status_code=400, detail="계정 이름을 입력하세요")
    return cleaned


def _account_name_key(name: str) -> str:
    return name.strip().casefold()


def _assert_account_name_available(
    accounts: SqliteAccountRepository,
    *,
    name: str,
    account_type: AccountType,
    parent_id: int | None,
    exclude_id: int | None = None,
) -> None:
    target = _account_name_key(name)
    for existing in accounts.find_all():
        if exclude_id is not None and existing.id == exclude_id:
            continue
        if existing.type != account_type or existing.parent_id != parent_id:
            continue
        if _account_name_key(existing.name) == target:
            raise HTTPException(
                status_code=400,
                detail=f"같은 위치에 이미 '{existing.name}' 계정이 있습니다",
            )


def _find_account_id_by_path(
    conn,
    path: tuple[str, ...],
    account_type: AccountType,
) -> int | None:
    """표준 시드의 path 멱등 키 조회.

    같은 이름이 다른 부모 아래에 있어도 parent_id 체인을 따라 정확한 path만
    찾는다. 중복 path가 이미 있으면 가장 먼저 만들어진 행을 대표로 삼는다.
    """
    parent_id: int | None = None
    found_id: int | None = None
    for name in path:
        row = conn.execute(
            "SELECT id FROM accounts WHERE name=? AND type=? AND parent_id IS ? "
            "ORDER BY id LIMIT 1",
            (name, account_type.value, parent_id),
        ).fetchone()
        if row is None:
            return None
        found_id = row["id"]
        parent_id = found_id
    return found_id


def _insert_standard_account(conn, item: StandardAccount) -> bool:
    if _find_account_id_by_path(conn, item.path, item.type) is not None:
        return False
    parent_id = None
    if len(item.path) > 1:
        parent_id = _find_account_id_by_path(conn, item.path[:-1], item.type)
        if parent_id is None:
            raise RuntimeError(f"표준 계정 상위 경로가 없습니다: {'/'.join(item.path[:-1])}")
    conn.execute(
        "INSERT INTO accounts (name, type, parent_id, is_placeholder) VALUES (?,?,?,?)",
        (item.path[-1], item.type.value, parent_id, int(item.is_group)),
    )
    return True


# ─── 앱 팩토리 ───────────────────────────────────────────

def create_app(db_path: str = DEFAULT_DB) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        conn = connect(db_path)
        init_db(conn)
        if db_path != ":memory:":  # 파일 DB만 백업 (D6)
            run_daily_backup(
                conn, Path(db_path).resolve().parent / "backups", datetime.date.today()
            )
        app.state.conn = conn
        yield
        conn.close()

    app = FastAPI(title="MoneyMap", lifespan=lifespan)

    # 단일 SQLite 커넥션을 여러 스레드가 동시에 쓰면 sqlite3.InterfaceError
    # ("bad parameter or other API misuse")가 난다 — 프론트가 요청 4개를
    # 병렬로 쏘기 때문. 단일 사용자 localhost이므로 요청 전체를 직렬화한다.
    request_lock = asyncio.Lock()

    @app.middleware("http")
    async def serialize_requests(request: Request, call_next):
        async with request_lock:
            return await call_next(request)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(DomainError)
    async def _domain_error(request: Request, exc: DomainError):
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=400, content={"detail": str(exc)})

    def repos(request: Request):
        conn = request.app.state.conn
        return {
            "conn": conn,
            "accounts": SqliteAccountRepository(conn),
            "txns": SqliteTransactionRepository(conn),
            "scenarios": SqliteScenarioRepository(conn),
            "rules": SqliteRecurringRuleRepository(conn),
            "queries": SqliteLedgerQueries(conn),
        }

    # ─── health (단절 배너용, D9) ───

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/status")
    def status(request: Request):
        """장부 상태 스트립(D8): 검산·백업·마지막 입력."""
        conn = request.app.state.conn
        total = conn.execute(
            "SELECT COALESCE(SUM(p.amount),0) AS s FROM postings p"
            " JOIN transactions t ON t.id=p.txn_id WHERE t.posted=1"
        ).fetchone()["s"]
        last_entry = conn.execute(
            "SELECT MAX(date) AS d FROM transactions WHERE posted=1 AND scenario_id=?",
            (ACTUAL_SCENARIO_ID,),
        ).fetchone()["d"]
        last_backup = None
        if db_path != ":memory:":
            backups = sorted(
                (Path(db_path).resolve().parent / "backups").glob("moneymap-*.db")
            )
            if backups:
                last_backup = backups[-1].stem.removeprefix("moneymap-")
        return {
            "trial_balance_ok": total == 0,
            "last_entry": last_entry,
            "last_backup": last_backup,
        }

    # ─── 계정 ───

    @app.get("/api/accounts")
    def list_accounts(request: Request):
        return [a.model_dump() for a in repos(request)["accounts"].find_all()]

    @app.post("/api/accounts", status_code=201)
    def create_account(body: AccountIn, request: Request):
        r = repos(request)
        name = _clean_account_name(body.name)
        account = Account(
            name=name, type=body.type, parent_id=body.parent_id,
            is_placeholder=body.is_placeholder,
        )
        validate_account_placement(account, r["accounts"])
        _assert_account_name_available(
            r["accounts"], name=name, account_type=body.type, parent_id=body.parent_id
        )
        if body.parent_id is not None and _account_referenced_by_rule(r["conn"], body.parent_id):
            raise HTTPException(
                status_code=400,
                detail="이 계정을 참조하는 반복 규칙을 먼저 하위 계정으로 바꾼 뒤 소분류를 추가하세요",
            )
        return r["accounts"].save(account).model_dump()

    @app.patch("/api/accounts/{account_id}")
    def update_account(account_id: int, body: AccountPatchIn, request: Request):
        r = repos(request)
        acc = r["accounts"].find_by_id(account_id)
        if acc is None:
            raise HTTPException(status_code=404, detail="계정이 없습니다")
        if acc.is_system:
            raise HTTPException(status_code=400, detail="시스템 계정은 이름을 바꿀 수 없습니다")
        name = _clean_account_name(body.name)
        _assert_account_name_available(
            r["accounts"],
            name=name,
            account_type=acc.type,
            parent_id=acc.parent_id,
            exclude_id=account_id,
        )
        return r["accounts"].save(acc.model_copy(update={"name": name})).model_dump()

    @app.post("/api/accounts/seed-standard")
    def seed_standard_accounts(request: Request):
        """표준 계정과목 시드 — path 기준 멱등, 단일 SQL 트랜잭션."""
        conn = repos(request)["conn"]
        created = 0
        skipped = 0
        try:
            conn.execute("BEGIN")
            roots = [a for a in STANDARD_ACCOUNTS if len(a.path) == 1]
            children = sorted(
                [a for a in STANDARD_ACCOUNTS if len(a.path) > 1],
                key=lambda a: len(a.path),
            )
            for item in [*roots, *children]:
                if _insert_standard_account(conn, item):
                    created += 1
                else:
                    skipped += 1
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {"created": created, "skipped": skipped}

    def _assert_postable(request: Request, account_ids: list[int]) -> None:
        """대분류(그룹) 계정에는 직접 기장 금지 (D24).

        비기장 = is_placeholder OR 자식 있음. 명시적 플래그(시드 카테고리)와
        자동 규칙(자식 붙은 순간)을 겹쳐 어느 경로로도 그룹에 기장되지 않게 한다.
        """
        acc_repo = repos(request)["accounts"]
        for aid in set(account_ids):
            a = acc_repo.find_by_id(aid)
            if a is None:
                continue  # 존재하지 않는 계정은 FK가 걸러낸다
            if a.is_placeholder or acc_repo.has_children(aid):
                raise HTTPException(
                    status_code=400,
                    detail=f"'{a.name}'은 그룹(대분류) 계정이라 직접 기장할 수 없습니다 — 하위 계정을 선택하세요",
                )

    @app.post("/api/accounts/{account_id}/placeholder")
    def set_placeholder(account_id: int, body: PlaceholderIn, request: Request):
        """계정을 그룹으로 전환/해제 (D24). 이미 직접 기장된 거래가 있으면 그룹 전환 차단."""
        r = repos(request)
        acc = r["accounts"].find_by_id(account_id)
        if acc is None:
            raise HTTPException(status_code=404, detail="계정이 없습니다")
        if body.is_placeholder and r["accounts"].has_postings(account_id):
            raise HTTPException(
                status_code=400,
                detail="이 계정에는 이미 거래가 있어 그룹으로 바꿀 수 없습니다 (거래를 옮긴 뒤 시도하세요)",
            )
        return r["accounts"].save(acc.model_copy(update={"is_placeholder": body.is_placeholder})).model_dump()

    @app.post("/api/accounts/{account_id}/archive")
    def archive_account(account_id: int, request: Request):
        """계정 보관 (소프트 삭제, D23) — 거래 역사는 그대로 남는다.

        차단 조건: ① 보관 안 된 자식이 있는 그룹 ② 반복 규칙이 참조 중
        (시나리오에 복사된 규칙 포함). 잔액≠0 경고는 프론트 confirm 담당.
        """
        r = repos(request)
        acc = r["accounts"].find_by_id(account_id)
        if acc is None:
            raise HTTPException(status_code=404, detail="계정이 없습니다")
        conn = r["conn"]
        children = conn.execute(
            "SELECT COUNT(*) AS n FROM accounts WHERE parent_id=? AND archived=0",
            (account_id,),
        ).fetchone()["n"]
        if children:
            raise HTTPException(status_code=400, detail=f"하위 계정 {children}개를 먼저 보관하세요")
        if _account_referenced_by_rule(conn, account_id):
            rules = _account_rule_reference_count(conn, account_id)
            raise HTTPException(
                status_code=400,
                detail=f"이 계정을 참조하는 반복 규칙 {rules}개(시나리오 포함)를 먼저 삭제하세요",
            )
        return r["accounts"].save(acc.model_copy(update={"archived": True})).model_dump()

    @app.post("/api/accounts/{account_id}/restore")
    def restore_account(account_id: int, request: Request):
        r = repos(request)
        acc = r["accounts"].find_by_id(account_id)
        if acc is None:
            raise HTTPException(status_code=404, detail="계정이 없습니다")
        # 부모가 보관 상태면 복원 시 트리가 어색해짐 — 부모를 먼저 복원
        if acc.parent_id is not None:
            parent = r["accounts"].find_by_id(acc.parent_id)
            if parent is not None and parent.archived:
                raise HTTPException(status_code=400, detail=f"상위 그룹 '{parent.name}'을 먼저 복원하세요")
        return r["accounts"].save(acc.model_copy(update={"archived": False})).model_dump()

    @app.post("/api/accounts/{account_id}/reclassify-direct")
    def reclassify_direct_postings(account_id: int, request: Request, to: int = Query(...)):
        """그룹에 남은 직접 posting을 명시적으로 하위 리프로 이동한다.

        기존 확정 거래의 postings 변조 트리거를 존중하기 위해 같은 트랜잭션 안에서
        affected 거래를 잠시 un-post한 뒤 account_id만 바꾸고 다시 post한다.
        """
        r = repos(request)
        parent = r["accounts"].find_by_id(account_id)
        child = r["accounts"].find_by_id(to)
        if parent is None or child is None:
            raise HTTPException(status_code=404, detail="계정이 없습니다")
        if child.parent_id != account_id:
            raise HTTPException(status_code=400, detail="이동 대상은 이 계정의 직접 하위 계정이어야 합니다")
        _assert_postable(request, [to])

        conn = r["conn"]
        try:
            conn.execute("BEGIN")
            txn_ids = [
                row["txn_id"]
                for row in conn.execute(
                    "SELECT DISTINCT txn_id FROM postings WHERE account_id=?",
                    (account_id,),
                ).fetchall()
            ]
            if txn_ids:
                marks = ",".join("?" for _ in txn_ids)
                conn.execute(f"UPDATE transactions SET posted=0 WHERE id IN ({marks})", txn_ids)
            cur = conn.execute(
                "UPDATE postings SET account_id=? WHERE account_id=?",
                (to, account_id),
            )
            if txn_ids:
                marks = ",".join("?" for _ in txn_ids)
                conn.execute(f"UPDATE transactions SET posted=1 WHERE id IN ({marks})", txn_ids)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        return {"moved_postings": cur.rowcount, "to": to}

    # ─── 거래 ───

    @app.get("/api/transactions")
    def list_transactions(request: Request, scenario_id: int = ACTUAL_SCENARIO_ID):
        return [t.model_dump() for t in repos(request)["txns"].find_by_scenario(scenario_id)]

    @app.post("/api/transactions", status_code=201)
    def create_transaction(body: TransactionIn, request: Request):
        try:
            txn = Transaction(
                scenario_id=body.scenario_id,
                date=body.date,
                description=body.description,
                postings=[
                    Posting(account_id=p.account_id, amount=Money(amount=p.amount))
                    for p in body.postings
                ],
            )
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        _assert_postable(request, [p.account_id for p in body.postings])
        saved = repos(request)["txns"].save(txn)
        return saved.model_dump()

    @app.delete("/api/transactions/{txn_id}")
    def delete_transaction(txn_id: int, request: Request):
        ok = repos(request)["txns"].delete(txn_id)
        if not ok:
            raise HTTPException(status_code=404, detail="거래가 없습니다")
        return {"deleted": txn_id}

    # ─── 반복 규칙 ───

    @app.get("/api/rules")
    def list_rules(request: Request, scenario_id: int = ACTUAL_SCENARIO_ID):
        return [r.model_dump() for r in repos(request)["rules"].find_by_scenario(scenario_id)]

    @app.post("/api/rules", status_code=201)
    def create_rule(body: RuleIn, request: Request):
        try:
            rule = RecurringRule(
                scenario_id=body.scenario_id,
                description=body.description,
                from_account_id=body.from_account_id,
                to_account_id=body.to_account_id,
                amount=Money(amount=body.amount),
                schedule=Schedule(spec=body.schedule),
                start_date=body.start_date,
                end_date=body.end_date,
            )
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        _assert_postable(request, [body.from_account_id, body.to_account_id])
        return repos(request)["rules"].save(rule).model_dump()

    @app.put("/api/rules/{rule_id}")
    def update_rule(rule_id: int, body: RuleIn, request: Request):
        r = repos(request)
        existing = [
            x for x in r["rules"].find_by_scenario(body.scenario_id) if x.id == rule_id
        ]
        if not existing:
            raise HTTPException(status_code=404, detail="규칙이 없습니다")
        try:
            updated = existing[0].model_copy(
                update={
                    "description": body.description,
                    "from_account_id": body.from_account_id,
                    "to_account_id": body.to_account_id,
                    "amount": Money(amount=body.amount),
                    "schedule": Schedule(spec=body.schedule),
                    "start_date": body.start_date,
                    "end_date": body.end_date,
                    # 과거 불변(D9): last_materialized는 유지 — 수정은 미래 실행에만 영향
                }
            )
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        _assert_postable(request, [body.from_account_id, body.to_account_id])
        return r["rules"].save(updated).model_dump()

    @app.delete("/api/rules/{rule_id}")
    def delete_rule(rule_id: int, request: Request):
        """규칙 삭제 — 이미 생성된 거래는 독립 사본이라 남는다 (D9 과거 불변).

        생성된 거래의 source_rule_id 참조(FK)는 끊고(NULL) 지운다 —
        거래는 보존하되 출처 badge만 사라진다.
        """
        conn = repos(request)["conn"]
        try:
            conn.execute(
                "UPDATE transactions SET source_rule_id=NULL WHERE source_rule_id=?",
                (rule_id,),
            )
            cur = conn.execute("DELETE FROM recurring_rules WHERE id=?", (rule_id,))
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="규칙이 없습니다")
        return {"deleted": rule_id}

    # ─── materialize (앱 로드 시 프론트가 호출 → 생성 배너 데이터, D10) ───

    @app.post("/api/materialize")
    def materialize(request: Request):
        r = repos(request)
        rules = r["rules"].find_by_scenario(ACTUAL_SCENARIO_ID)
        plan = plan_materialization(rules, today=datetime.date.today())
        ids = apply_materialization(r["conn"], plan)
        return {
            "created": len(plan.transactions),
            "transactions": [
                {
                    "id": txn_id,  # 배너의 개별 삭제(D10)용
                    "date": t.date.isoformat(),
                    "description": t.description,
                    "source_rule_id": t.source_rule_id,
                }
                for txn_id, t in zip(ids, plan.transactions)
            ],
        }

    # ─── 시나리오 (copy-on-fork, D5·D7) ───

    @app.get("/api/scenarios")
    def list_scenarios(request: Request):
        return [
            s.model_dump()
            for s in repos(request)["scenarios"].list_all()
            if not s.is_actual
        ]

    @app.post("/api/scenarios", status_code=201)
    def create_scenario(body: ScenarioIn, request: Request):
        r = repos(request)
        scenario, copied = app_services.fork_scenario(
            body.name, body.fork_date, r["scenarios"], r["rules"]
        )
        return {**scenario.model_dump(), "copied_rules": copied}

    # ─── 잔액·순자산·프로젝션 ───

    @app.get("/api/balances")
    def balances(
        request: Request,
        scenario_id: int = ACTUAL_SCENARIO_ID,
        at: datetime.date | None = None,
    ):
        r = repos(request)
        at = at or datetime.date.today()
        out = []
        for a in r["accounts"].find_all():
            assert a.id is not None
            raw = r["queries"].balance_at(a.id, at, scenario_id).amount
            out.append(
                {
                    "account_id": a.id,
                    "name": a.name,
                    "type": a.type.value,
                    "balance": raw,
                    "display_balance": raw * a.display_multiplier(),
                }
            )
        return {"at": at.isoformat(), "net_worth": r["queries"].net_worth_at(at, scenario_id), "accounts": out}

    @app.get("/api/projection")
    def projection(
        request: Request,
        months: int = Query(default=12, ge=1, le=60),
        scenario_ids: str = "",  # "2,3"
    ):
        r = repos(request)
        ids = [int(s) for s in scenario_ids.split(",") if s.strip()]
        if len(ids) > 3:
            raise HTTPException(status_code=400, detail="차트에는 최대 3개 시나리오만 표시됩니다 (D19)")
        return {
            "series": app_services.build_projection(
                accounts=r["accounts"].find_all(),
                txn_repo=r["txns"],
                rule_repo=r["rules"],
                scenario_repo=r["scenarios"],
                net_worth_at=r["queries"].net_worth_at,
                actual_base_net_worth=r["queries"].actual_base_net_worth,
                today=datetime.date.today(),
                months=months,
                scenario_ids=ids,
            )
        }

    return app


app = create_app()
