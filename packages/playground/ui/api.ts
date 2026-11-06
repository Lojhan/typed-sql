const fragment = new URLSearchParams(location.hash.slice(1));
export const token = fragment.get("session") ?? sessionStorage.getItem("typed-sql-session") ?? "";
if (fragment.has("session")) {
  sessionStorage.setItem("typed-sql-session", token);
  history.replaceState(null, "", location.pathname);
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-typed-sql-session": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "Request failed");
  return result as T;
}
