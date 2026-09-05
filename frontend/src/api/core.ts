// 백엔드 API 클라이언트 — 로컬 기본값은 유지하고 E2E/배포에서 주입할 수 있다.
const BASE = (import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8765/api").replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public context: Record<string, unknown> = {},
    public detail: unknown = undefined,
  ) {
    super(message);
  }
}

export async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    let code: string | undefined;
    let context: Record<string, unknown> = {};
    let rawDetail: unknown;
    try {
      const body = await res.json();
      const bodyDetail = body.detail;
      rawDetail = bodyDetail;
      if (typeof bodyDetail === "string") {
        detail = bodyDetail;
      } else if (bodyDetail && typeof bodyDetail === "object" && !Array.isArray(bodyDetail)) {
        context = { ...bodyDetail };
        delete context.code;
        delete context.message;
        detail = typeof bodyDetail.message === "string" ? bodyDetail.message : detail;
        code = typeof bodyDetail.code === "string" ? bodyDetail.code : undefined;
      }
    } catch {
      /* body 없음 */
    }
    throw new ApiError(res.status, detail, code, context, rawDetail);
  }
  return res.json();
}

