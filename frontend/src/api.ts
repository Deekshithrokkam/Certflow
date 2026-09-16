export const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
let csrf = "";
export const setCSRF = (token: string) => (csrf = token);
export const getCSRF = () => csrf;
export async function api<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}/api${path}`, {
      credentials: "include",
      method: body === undefined ? "GET" : "POST",
      headers:
        body instanceof FormData
          ? { "X-CSRF-Token": csrf }
          : { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
  } catch {
    throw Error(
      "Connection interrupted. Please check your internet connection. For a send request, check the batch status before retrying.",
    );
  }
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!response.ok) throw Error(data.error ?? "Request failed.");
  return data as T;
}
