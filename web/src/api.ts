// A thin wrapper around fetch. Every call is same-origin, so the browser
// attaches the httpOnly auth cookies by itself: this code never sees a token.

export type ApiResult<T> = {
  ok: boolean;
  status: number;
  data: T | null;
  error: string | null;
};

export type LogEntry = {
  id: number;
  method: string;
  path: string;
  status: number;
};

type ErrorBody = { errors?: { msg: string }[] };

let nextId = 1;
let logListener: (entry: LogEntry) => void = () => {};

/** Lets the UI show each request in the "Requests" panel. */
export const onRequest = (listener: (entry: LogEntry) => void) => {
  logListener = listener;
};

export async function api<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    logListener({ id: nextId++, method, path, status: 0 });
    return {
      ok: false,
      status: 0,
      data: null,
      error: "Could not reach the server.",
    };
  }

  const json = (await response.json().catch(() => null)) as unknown;
  logListener({ id: nextId++, method, path, status: response.status });

  if (response.ok) {
    return { ok: true, status: response.status, data: json as T, error: null };
  }
  const messages = (json as ErrorBody | null)?.errors?.map((e) => e.msg);
  return {
    ok: false,
    status: response.status,
    data: null,
    error: messages?.length
      ? messages.join(" ")
      : `Request failed (${response.status}).`,
  };
}

let refreshInFlight: Promise<ApiResult<unknown>> | null = null;

/**
 * Rotates the session, one request at a time.
 *
 * The server replaces the refresh token on every use and treats a second use
 * of the old one as theft, revoking the session. So two refreshes sent at
 * once (two components mounting, or React running an effect twice in
 * development) would log the user out. Concurrent callers share one request.
 */
export function refreshSession(): Promise<ApiResult<unknown>> {
  refreshInFlight ??= api("POST", "/auth/refresh").finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}
