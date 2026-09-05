import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Scenario } from "../../api";
import { useQuery } from "./useQuery";

export function DeleteScenarioDialog({
  scenario,
  close,
  deleted,
}: {
  scenario: Scenario;
  close: () => void;
  deleted: (message: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const query = useQuery(`impact:${scenario.id}`, (signal) =>
    api.deletionImpact(scenario.id, signal),
  );
  const [replacement, setReplacement] = useState<typeof query.data>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = replacement ?? query.data;
  useEffect(() => {
    if (!busy && error) {
      if (current) confirmButton.current?.focus();
      else title.current?.focus();
    }
  }, [busy, error, current]);
  useEffect(() => {
    if (!opener.current)
      opener.current = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    title.current?.focus();
    return () => {
      element?.close();
      opener.current?.focus();
    };
  }, []);
  return (
    <dialog
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ];
        const first = controls[0],
          last = controls.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === title.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      ref={dialog}
      className="scenario-delete-dialog"
      aria-labelledby="delete-scenario-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === dialog.current && !busy) {
          const bounds = dialog.current.getBoundingClientRect();
          if (
            e.clientX < bounds.left ||
            e.clientX > bounds.right ||
            e.clientY < bounds.top ||
            e.clientY > bounds.bottom
          )
            close();
        }
      }}
    >
      <div>
        <h2 id="delete-scenario-title" tabIndex={-1} ref={title}>
          시나리오 영구 삭제
        </h2>
        <p>
          <strong>{current?.impact.name ?? scenario.name}</strong>와 소유한
          가정을 영구 삭제합니다. 실제 장부는 유지되며 삭제는 되돌릴 수
          없습니다.
        </p>
        {query.error ? (
          <p role="alert">
            {query.error}{" "}
            <button className="btn" onClick={query.reload}>
              영향 다시 확인
            </button>
          </p>
        ) : !current ? (
          <p role="status">삭제 영향을 확인하는 중…</p>
        ) : (
          <dl>
            <dt>반복 규칙</dt>
            <dd>{current.impact.rules}개</dd>
            <dt>예정 거래</dt>
            <dd>{current.impact.planned_transactions}개</dd>
            <dt>과거 규칙 발생 거래</dt>
            <dd>{current.impact.generated_transactions}개</dd>
            <dt>분개</dt>
            <dd>{current.impact.postings}개</dd>
          </dl>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="scenario-controls">
          <button className="btn secondary" disabled={busy} onClick={close}>
            취소
          </button>
          <button
            ref={confirmButton}
            className="btn danger"
            disabled={busy || !current}
            onClick={async () => {
              if (!current || busy) return;
              setBusy(true);
              setError("");
              try {
                const result = await api.deleteScenario(
                  scenario.id,
                  current.etag,
                );
                deleted(
                  `반복 규칙 ${result.rules}개와 예정 거래 ${result.planned_transactions}개를 포함해 시나리오를 영구 삭제했습니다${result.generated_transactions ? ` · 과거 규칙 발생 거래 ${result.generated_transactions}개` : ""}`,
                );
              } catch (e) {
                if (e instanceof ApiError && e.status === 412) {
                  setReplacement(undefined);
                  try {
                    setReplacement(await api.deletionImpact(scenario.id));
                    setError(
                      "삭제 영향이 변경됐습니다. 최신 개수를 확인한 뒤 영구 삭제를 다시 눌러주세요.",
                    );
                  } catch (refreshError) {
                    setError((refreshError as Error).message);
                    query.reload();
                  }
                } else setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            영구 삭제
          </button>
        </div>
      </div>
    </dialog>
  );
}
