/** Тонкая обёртка над fetch для обращений к API ГЕОПУЛЬС. */

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export type ApiError = {
  status: number;
  detail: string;
};

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const problem = (await response.json()) as { detail?: string; title?: string };
      detail = problem.detail ?? problem.title ?? detail;
    } catch {
      // тело ответа может быть не JSON — оставляем статусную строку
    }
    throw new Error(`${response.status}: ${detail}`);
  }

  return (await response.json()) as T;
}
