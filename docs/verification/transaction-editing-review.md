# 거래 수정 코드 리뷰 (2026-09-12)

Status: DONE — 2026-09-13 사용자 승인으로 R1–R8 수정 및 최종 회귀 검증 완료. 남은 확정 결함 0개. 아래 초기 발견/점검표는 수정 전 기록이며 배포 기록은 아니다.

## 브랜치와 검토 범위

- 사용자 요청으로 현재 작업 공간에서 `main` → `feature/transaction-editing`을 생성·전환했다. 별도 worktree 생성이나 파일 이동은 하지 않았다.
- HEAD와 비교 기준(최신 `origin/main`과의 merge-base)은 `8dcce37`이다. 브랜치 전환 전후 변경 파일 목록과 tracked diff가 동일하다. 커밋·푸시·PR 생성은 하지 않았다.
- Scope Check: DRIFT DETECTED (기존 작업 혼재). 요청한 거래 수정 외에 앞서 승인된 CSV 이관·태그·계정 순서 변경도 아직 미커밋 상태다. 이번에 새로 범위를 확장한 것으로 간주하지 않고, 관련 경계를 함께 검토했다.
- tracked diff는 38개 파일, +947/-205줄이다. 여기에 `git diff`가 누락하는 untracked 신규 구현·테스트·설계 파일을 추가로 확인했다.
- 설계 근거: [거래 수정 설계](../designs/transaction-editing.md), [테스트 계획](../designs/transaction-editing-test-plan.md), `TODOS.md`, `DESIGN.md`.
- 실제 장부·개인 CSV로 QA하지 않았다. 기존 개발서버의 자동 재시작/실제 DB 업그레이드 사실은 [구현 검증](transaction-editing.md)에 별도로 기록돼 있으며, 이번 리뷰에서는 앱 소스나 실제 DB를 수정하지 않았다.

## 검증 결과

- Backend: `uv run pytest -q` → **434 passed**, 15.61초. 기존 Starlette/httpx deprecation warning 1개.
- Frontend: `MONEYMAP_E2E_BACKEND_PORT=8968 MONEYMAP_E2E_FRONTEND_PORT=5376 env -u MONEYMAP_E2E_API_BASE npm run e2e` → **133 passed**, 2.3분. 포트별 임시 DB 사용.
- `npm run build` 통과. 기존 번들 542.32 kB 경고는 남아 있다.
- `git diff --check` 통과.
- 추가 재현: 합성 CSV/임시 SQLite, 실제 순수 TS 함수 실행, Vite 5377 + Playwright(모든 API를 합성 응답으로 가로챔). 실제 서버에 요청하지 않았다. 추가 재현은 아래 누락된 회귀를 발견했으므로 전체 테스트 통과를 결함 없음으로 해석하지 않는다.

## Findings와 권장 수정

수정 전 Pre-Landing Review: **8 issues (1 critical, 7 informational)**. 별도 정리 제안 1개는 결함 수에서 제외한다. 승인 후 처리 결과는 문서 끝에 기록한다.

### R1. [P1 / CRITICAL] 개인 주소가 공개 저장소용 소스에 포함됨 (confidence 10/10)

- 위치: `backend/moneymap/legacy_import.py:30`.
- `ROW_CORRECTIONS`에 원본 메모에서 가져온 아파트 동·호수까지의 주소가 들어 있다. 코드 적용 지점은 `correction = ROW_CORRECTIONS.get(source_row)`와 `memo = memo.replace(*correction)`이다. 개인정보 자체는 이 보고서에 재인용하지 않는다.
- `gh repo view --json isPrivate` 결과는 `false`다. 현재 해당 파일은 untracked이며, 이번 리뷰에서 공개·푸시하지 않았다. 그대로 커밋·공개하는 위험을 지적한다.
- 권장: 사용자의 오타 교정은 유지하되 실제 교정 문자열은 Git 제외된 로컬 매핑으로 분리하고 코드·테스트에는 합성 예시만 남긴다. 원본 장부 메모를 지우거나 다시 이관하는 작업은 아니다.
- 분류: **ASK** (개인 데이터 보관 경계 변경).

### R2. [P2 / INFORMATIONAL] 분할 수정 후 같은 CSV 재이관 실패 (confidence 10/10)

- 위치: `backend/moneymap/legacy_import.py:388`, `:391`.
- 근거: `HAVING SUM(p.amount) != 0 OR COUNT(*) != 2` 및 `posting_count != len(rows) * 2`가 이미 이관돼 수정된 거래에도 적용된다.
- 재현: 합성 CSV 2건 이관 → 첫 거래의 차변 10,000을 기존 행 6,000 + 새 행 4,000으로 분할 → 수정 성공, 3행 합계 0 → 동일 CSV 재이관 시 `ValueError('이관 사후 검산 실패')`.
- 기존 수정 값은 롤백으로 보존된다. 중복 생성이나 금액 손상이 아니라, 재이관 완료가 막히는 문제다.
- 권장: 정확히 두 행이어야 한다는 이관 검증은 이번 호출에서 새로 삽입한 거래에만 적용한다. 기존 provenance 키의 거래는 수정된 행 구조를 보존하고 정상적으로 건너뛴다. 전체 행 수 검증도 이 경계를 반영한다.
- 분류: **ASK**, 테스트: `backend/tests/test_transaction_edit.py`의 재이관 회귀 보강.

### R3. [P2 / INFORMATIONAL] 수정·결과 확인 API의 요청 크기 제한 누락 (confidence 10/10)

- 위치: 신규 경로 `backend/moneymap/routers/transactions.py:124`, 기존 경계 `backend/moneymap/api.py:35`.
- 근거: `scope.get("method") == "POST"`와 `scope.get("path") == "/api/transactions"`만 64 KiB 제한을 거친다. 새 PUT 단건 수정과 POST edit-result는 제외된다.
- 합성 TestClient에서 유효한 JSON 앞에 공백을 붙여 65,845바이트로 전송한 결과, 생성은 413이지만 수정과 결과 확인은 200이었다. 필드 길이 검증은 JSON을 읽고 파싱한 뒤 실행되므로 전체 본문 크기를 제한하지 못한다.
- 권장: 기존 middleware의 Content-Length/실제 수신 바이트 검증을 두 신규 경로에도 적용한다. 클라이언트의 확정된 413 처리와 초안 보존도 함께 검증한다.
- 분류: **ASK**, 테스트: `backend/tests/test_transaction_edit.py`, 기존 body-limit 테스트의 스트리밍 경로.

### R4. [P2 / INFORMATIONAL] 과거 0원 개시잔액의 새 대상 유형 검증 누락 (confidence 9/10)

- 위치: `backend/moneymap/domain/transaction_edit.py:101`.
- 근거: `if desired.signed_amount == 0:` 다음의 `elif`에서만 `opening_balance_posting_amount(...)`를 호출한다. 일반 `usable(...)` 검사는 개시잔액 대상의 자산/부채 유형을 확인하지 않는다.
- 합성 도메인 명령에서 기존 0원 자산↔시스템 거래의 대상을 비용 계정으로 바꿔도 `edited_postings`와 `validate_balanced`가 허용했다. 비영(0이 아닌) 개시잔액의 같은 변경은 기존 테스트에서 거절된다.
- 권장: 기존 0원 보존 예외는 유지하되, 대상을 바꾸면 금액이 0이어도 개시잔액을 둘 수 있는 계정 유형인지 검사한다. 기존 원본 참조를 유지하는 예외까지 제거하지 않는다.
- 분류: **ASK**, 테스트: `test_opening_sign_rules_and_new_target_type_are_checked`에 0원 대상 변경 추가.

### R5. [P2 / INFORMATIONAL] 유지한 계정을 새 추천으로 선택한 것처럼 안내 (confidence 10/10)

- 위치: `frontend/src/views/TxnInput.tsx:114`.
- 근거: `draft[s].source === "auto"`의 개수만으로 `"마지막으로 저장한 계정을 선택했습니다."`를 표시한다. 새 정책의 `applyPair`는 이미 채워진 계정을 건너뛴다.
- 실제 순수 함수 재현: 아이템 A의 [101,102]가 자동 선택된 뒤, B의 추천 [201,202]를 받아도 [101,102]와 auto 출처가 유지되는데 위 문구를 표시한다.
- 권장: 현재 조회가 실제로 채운 쪽을 기준으로 안내한다. 이전 선택을 유지했다면 새 아이템의 추천을 적용했다고 말하지 않는다. 계정을 유지하는 승인 정책은 바꾸지 않는다.
- 분류: **ASK**, 테스트: `frontend/e2e/transaction-input-review.spec.ts`의 서로 다른 추천을 가진 A→B 전환.

### R6. [P2 / INFORMATIONAL] 실제 목록 스크롤이 복원되지 않음 (confidence 10/10)

- 위치: `frontend/src/views/History.tsx:36`, `:31`.
- 근거: `scrollY: window.scrollY` / `window.scrollTo(0, snapshot.scrollY)`를 사용하지만 라우트 컨테이너는 `.main { overflow-y: auto; }`다.
- 합성 150건 목록, 1440×900에서 수정 후 취소 재현: 진입 전 `{main: 5231, window: 0}`, 복귀 후 `{main: 0, window: 0}`.
- 기존 E2E도 `window.scrollY`를 비교하므로 실제 스크롤 유실을 놓친다.
- 권장: 실제 목록의 스크롤 컨테이너 위치를 저장·복원하고 저장/취소/브라우저 Back 각각에서 충분히 긴 목록의 위치와 포커스를 검증한다. 기존 가로 스크롤·필터 복원은 유지한다.
- 분류: **ASK**, 테스트: `frontend/e2e/transaction-edit.spec.ts`.

### R7. [P2 / INFORMATIONAL] 충돌 복구의 긴 메모가 모바일에서 잘림 (confidence 10/10)

- 위치: `frontend/src/views/TxnEdit.tsx:21`, `:150`.
- 근거: `<pre>{draft.memo}</pre>` / `<pre>{latest.memo}</pre>`에 줄바꿈 처리가 없으며 모바일 main은 `overflow-x: hidden`이다.
- 390px, 합성 긴 메모, 409 충돌 후 두 메모를 표시한 재현: 각각 `clientWidth=366`, `scrollWidth=10082`, `whiteSpace=pre`. 내용이 화면 밖으로 넘친다.
- 권장: 기존 History 메모처럼 `white-space: pre-wrap; overflow-wrap: anywhere`와 본문 폰트를 적용해 원문 줄바꿈과 긴 한 줄을 모두 읽게 한다.
- 분류: **ASK** (사용자 표시 변경 + 회귀 테스트), 테스트: `frontend/e2e/transaction-edit.spec.ts`.

### R8. [P2 / INFORMATIONAL] 금액 쉼표 때문에 원래 값도 변경으로 판정 (confidence 10/10)

- 위치: `frontend/src/views/transactionEditState.ts:12`, `:54`; `frontend/src/views/transactionInputState.ts:91`.
- 근거: 초기값은 `String(Math.abs(p.amount))`, 입력 후 값은 `amountInput`의 천 단위 쉼표 문자열이다. `draftIdentity`는 `draft.amount`를 그대로 비교하고 모드 전환은 `debits[0].amount !== credits[0].amount`를 검사한다.
- 실제 TS 함수 재현: 원래 `"1000"`에 같은 금액을 다시 입력하면 `"1,000"`이 되어 dirty=true. 분할 한쪽만 다시 입력한 경우 두 합계는 같고 검산도 유효하지만 기본 모드 복귀는 거절된다.
- 권장: 초기 표시와 비교 기준을 일관되게 정규화한다. 유효한 같은 금액의 표기 차이는 무시하되 빈 값·잘못된 입력·posting ID 차이는 보존한다.
- 분류: **ASK**, 테스트: `frontend/e2e/transaction-edit-state.spec.ts`와 이탈 경고 회귀.

### A1. [ADVISORY] 사용하지 않는 `_find_path` (confidence 10/10)

- 위치: `backend/moneymap/legacy_import.py:225`.
- 전체 검색 결과 정의만 있고 호출자는 없다. 실제 경로는 `_resolve_target` → `_ensure_path`다.
- 선택적 정리: 약 15줄 삭제 가능. 동작 결함이 아니므로 위 8건이나 품질 점수에는 포함하지 않는다. 자동 삭제하지 않았다.

## 제안 회귀 테스트 (아직 추가·실행하지 않은 초안)

아래는 승인 후 기존 테스트 파일에 넣을 최소 skeleton이다. 이번에 통과한 434/133개에 포함되지 않는다.

`backend/tests/test_transaction_edit.py`:

```python
@pytest.mark.parametrize('method,suffix', [('put', ''), ('post', '/edit-result')])
def test_edit_body_limit(client, original, method, suffix):
    import json
    payload = ' ' * 65537 + json.dumps(body(original))
    response = getattr(client, method)(
        f"/api/transactions/{original['id']}{suffix}", content=payload,
        headers={'Content-Type': 'application/json'},
    )
    assert response.status_code == 413
    assert detail(client, original['id']) == original

def test_reimport_preserves_edited_split(client, tmp_path):
    from test_legacy_import import _write_fixture
    from moneymap.legacy_import import import_legacy_csv
    source, classifications = _write_fixture(tmp_path)
    conn = connect(client.app.state.db_path)
    try:
        import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
        tid = conn.execute(
            'SELECT txn_id FROM transaction_import_provenance ORDER BY txn_id LIMIT 1'
        ).fetchone()[0]
        original = detail(client, tid)
        command = body(original)
        command['postings'][0]['amount'] = 6000
        command['postings'].append({
            'account_id': original['postings'][0]['account_id'], 'amount': 4000,
        })
        assert put(client, original, command).status_code == 200
        edited = detail(client, tid)
        result = import_legacy_csv(conn, source, classifications, apply=True, expected_hash=None)
        assert result['inserted'] == 0 and result['skipped_existing'] == 2
        assert detail(client, tid) == edited
    finally:
        conn.close()
```

`frontend/e2e/transaction-edit.spec.ts`에 추가할 사례:

```ts
test("edit return restores actual main scroll", async ({ page }) => {
  // mockEditor와 같은 경로에 긴 합성 거래 목록을 준비한다.
  // main.scrollTop > 0을 확인한 뒤 저장·취소·Back을 각각 검증한다.
  // window.scrollY가 아닌 main.scrollTop과 대상 행 위치를 비교한다.
});
test("conflict memo wraps within 390px", async ({ page }) => {
  // 390px 화면과 긴 한 줄 메모로 409를 재현하고 초안·최신 메모를 모두 표시한다.
  // 각 pre의 scrollWidth <= clientWidth와 원문 보존을 검증한다.
});
```

위 두 skeleton의 주석은 테스트 의도를 표시한 것이며 빈 테스트를 그대로 등록해서는 안 된다.

## Plan Completion Audit

모든 항목은 현재 repo의 DIFF-VERIFIABLE 항목이다. 아래는 중복된 문장들을 구현/검증 단위로 묶은 점검표이며 외부 서비스 설정은 요구하지 않는다.

| 항목 | 결과 | 근거 |
|---|---|---|
| T1: DB 토큰·새 삽입·다른 writer·ABA 방지 | DONE | transaction_edit_migration.py, migration/재분류/규칙 삭제/ID 재사용 테스트 |
| T1: 최소 receipt, 원자성, 삭제 이후 보존 | DONE | transaction_edit.py와 receipt/concurrent resolver 테스트 |
| T2: 실제 단건 조회·사용자 필드 수정·같은 ID | DONE | GET/PUT 경로, full_edit 테스트 |
| T2: posting 소속·기존 ID·분할 추가/삭제 | DONE | edited_postings, split/foreign ID 테스트 |
| T2: 보관/그룹 원본 유지·새 행 검증 | DONE | retained_accounts 테스트 |
| T2: 0원 유지/정정·일반 거래 시스템 계정 거부 | DONE | legacy_zero/invalid_edit 테스트 |
| T2: 개시잔액 구조·중복·대상 규칙 | PARTIAL | 구조/동시 중복 검사 구현, R4의 0원 대상 유형 누락 |
| T2: 원본 provenance/동일 CSV 재이관 | PARTIAL | 원본 보존 구현, R2의 분할 재이관 실패 |
| T2: KRW 제한·출처·반복 watermark 보존 | DONE | non_krw/reclassification/rule 및 generated E2E |
| T2: 요청 크기/길이/형식 제한 | PARTIAL | DTO 한도 구현, R3 전체 요청 크기 누락 |
| T3: 공통 폼과 생성·수정 수명주기 분리 | DONE | TransactionForm, TxnInput, TxnEdit |
| T3: 이미 선택한 계정 유지·빈 쪽 추천 | DONE | applyPair, 갱신된 입력 회귀 테스트 |
| T3: 실제 추천 적용 상태 안내 | PARTIAL | R5 |
| T3/T4: 초안 원복 및 손실 없는 모드 전환 | PARTIAL | ID 유지 구현, R8 금액 표기 불일치 |
| T4: stale 버전·삭제 충돌·자동 병합 금지 | DONE | TxnEdit와 stale/conflict 테스트 |
| T4: 불명 결과 잠금·동일 요청 확인·새 UUID 재시도 | DONE | classifyEditResult와 lost/not_applied/uncertain 테스트 |
| T4: 이탈 경고·늦은 응답 보호 | DONE | useBlocker/beforeunload와 pending-save E2E; R8 원복 예외 별도 |
| T4: 필터·포커스·목록 위치 복원 | PARTIAL | 필터/포커스 구현, R6 실제 스크롤 누락 |
| T4: 충돌 초안·최신 메모 읽기 | PARTIAL | 데이터 유지 구현, R7 좁은 화면 표시 누락 |
| T5: 전체 회귀/통합 테스트와 단건 조회 성능 | PARTIAL | 전체 통과하나 위 추가 재현 사례가 기존 테스트에 없음 |
| T6: 빌드·검증 기록·업그레이드 안내 | DONE | 이번 재실행 및 transaction-editing.md/CHANGELOG/TODOS |

완료 13, 부분 완료 8, 미구현 0. T2 조정 경계는 별도 app-service를 추가하지 않고 도메인 검증+SQLite adapter로 구현했다. 기존 백업/짧은 쓰기 경계와 같은 목적을 달성하는 변경이다.

핵심 불일치의 영향은 중간 수준이다. R2는 재이관을 막고, R3은 기존 크기 방어 경계를 누락하며, R6는 승인된 목록 복귀 경험을 놓친다. 이력상 의도적인 범위 제외 증거가 없으므로 누락된 교차 기능/경계 테스트로 판단한다. R1은 과거 이관 구현에 포함된 별도 공개 전 개인정보 위험이다.

## Specialist / adversarial 상태

- Testing: 0건. Security: 2건. Data Migration: 1건. Performance: 0건. API Contract: 1건. Maintainability: 1건. Design: 2건. Simplification: advisory 1건.
- 조건부 specialist의 자동 제외 대상은 없었다. migration scope 탐지 도구는 false였으나 untracked 신규 migration을 직접 확인해 포함했다. 동시 실행 한도에 따라 검토자를 나누어 실행했다.
- 본 검토와 독립 검토자는 동일 Codex 계열이다. Claude 또는 다른 모델과의 합의로 표현하지 않는다.
- Codex 호스트의 중첩 CLI pass는 생략했다: [running under Codex — nested codex passes skipped; set GSTACK_FORCE_CODEX_REVIEW=1 to force]
- 독립 새 문맥의 in-host adversarial 검토는 R2를 재확인했고 추가 확정 문제는 없었다. 구현 소스는 확인하되 테스트·fixture는 이름과 검증 문서 요약만 제공했다. 실제 DB·개인 CSV는 읽지 않았다.
- Red Team은 receipt 확정 경계, 늦은 응답, 타임아웃, 조회 일관성, 분개 ID, 기존 예외와 충돌 복구를 확인했으며 추가 확정 문제는 없었다.
- 전체 확정 결함 기준 품질 점수는 4.5/10이다(10 - critical 1×2 - informational 7×0.5). 선택적 정리 제안은 제외한다. 테스트 통과율이나 배포 승인 점수가 아니다.
- PR이 없어 Greptile/PR queue 점검은 해당하지 않는다. slop 스크립트도 설치된 프로젝트 명령에 없다. 기존 태그 UI·다중 통화·계정 시간 이력·전체 목록 성능 TODO는 후속 범위로 유지한다.

초기 리뷰에서는 승인 대기였으므로 clean/최종 Eng Review 기록을 만들지 않았다. 이후 사용자가 8개 결함 수정과 회귀 테스트를 승인했다. 선택적 A1 정리는 승인 요청에서 제외했으므로 그대로 둔다.

## 승인 후 수정 (2026-09-13)

| 항목 | 적용한 수정 | 회귀 검증 |
|---|---|---|
| R1 | 실제 교정 두 건을 Git 제외된 로컬 JSON으로 이동. 원본 SHA-256에 일치하는 교정만 적용하고 raw_memo는 보존 | `test_private_corrections_are_source_scoped_and_preserve_raw_memo`, `test_private_corrections_reject_invalid_pairs` |
| R2 | 이전 분개 수를 쓰기 잠금 안에서 기준으로 잡고 신규 삽입에만 두 행 증가를 요구. 전체 균형 검사는 유지 | `test_reimport_preserves_edited_split_and_checks_only_new_posting_count`: 전부 중복 및 기존 수정+신규 혼합, dry-run/apply, provenance/수정본 보존 |
| R3 | 실제 라우트와 같은 단일 경로 세그먼트를 보호해 `+1`·앞자리 0 표기도 제한. PUT의 413은 확정 실패로 처리해 초안 수정/재시도 허용 | `test_edit_commands_have_preparse_body_limit`: 두 API × 헤더/수신 바이트 × 세 ID 표기, receipt/거래 불변; E2E `known save failure 413`은 resolver 자동 호출 없음도 검증 |
| R4 | 새 0원 대상도 자산/부채만 허용. 기존 대상 유지 예외는 보존 | `test_zero_opening_new_target_type_is_checked`: 비용/수익/순자산 거절, 자산/부채 허용 |
| R5 | 현재 조회가 실제로 빈 쪽을 채운 사실로 안내문 생성 | E2E `new recall does not claim to apply a pair when prior automatic choices are retained` |
| R6 | `.main.scrollTop`을 저장·복원. 가로 스크롤/필터/포커스 기존 처리 유지 | E2E `cancel and native Back protect dirty draft and restore filter, scroll, focus`, `saved edit restores actual long-list scroll and focus`: 0보다 큰 실제 컨테이너 위치를 비교 |
| R7 | 복구 메모의 pre-wrap/overflow-wrap/font 적용 | E2E `conflict recovery wraps long memo text on mobile`: 390px 두 메모의 원문과 scrollWidth/clientWidth 검증 |
| R8 | 초기 표시와 dirty/mode 비교를 동일한 금액 정규화 기준으로 통일 | 상태 테스트 `equal formatted amounts are not dirty and split mode keeps identities`, E2E `reverting an amount removes leave protection despite comma formatting` |

개인 교정 파일 운영/백업 안내: [로컬 교정 설정](legacy-local-corrections.md). 실제 거래를 수정하거나 CSV를 다시 이관하지 않았다. DB 스키마/마이그레이션 변경도 없다. 기존 개발서버의 소스 자동 재시작은 여전히 켜져 있으므로 실제 DB 파일 자체가 전혀 열리지 않았다는 의미는 아니다.

독립 재검토에서 R3의 `[0-9]+`와 실제 라우터 정수 변환 간 차이를 추가 발견해 `[^/]+`로 보완했고 `+1`과 앞자리 0 회귀를 추가했다. 같은 Codex 계열 검토이며 별도 모델 합의로 해석하지 않는다.

수정 후 계획 점검: 기존 PARTIAL 8개는 위 구현/회귀 보강으로 해소했다. 21개 구현 항목이 완료됐으며 미구현 범위 확장이나 별도 배포는 없다. 최종 테스트 결과는 아래에 기록한다.

### 최종 검증

- Backend: `uv run pytest -q` → **458 passed**, 15.94초. 기존 deprecation warning 1개.
- Frontend: `MONEYMAP_E2E_BACKEND_PORT=8970 MONEYMAP_E2E_FRONTEND_PORT=5379 env -u MONEYMAP_E2E_API_BASE npm run e2e` → **139 passed**, 2.9분. 최종 서버 코드를 새 임시 DB로 실행했다. 앞선 전체 실행도 139개 통과했다.
- `npm run build` 및 `git diff --check` 통과. 기존 JS 번들 크기 경고(542.67 kB)는 남아 있다.
- 독립 Red Team 최종 검토: **NO FINDINGS**. R3 경로 표기 보완까지 확인했다.
- R1–R8 모두 **FIXED + TEST**. 선택적 A1 미사용 함수는 그대로 유지했다. 기존 미커밋 작업 보존, 커밋·푸시·PR·배포 없음.
