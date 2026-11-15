// Every request of the admin site goes through here, to /api/admin only. Its session is an HttpOnly cookie that the
// browser keeps and sends only to that path; a 401 means the session ended, and the site shows its sign-in.
let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/admin${path}`, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0);
  }
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  // Signing in and signing up answer 401/403 with their own words, which must reach the person.
  if (res.status === 401 && !path.startsWith("/auth/")) {
    onUnauthorized();
    throw new ApiError("Please sign in again.", 401, data);
  }
  if (!res.ok) throw new ApiError(data.error || `Something went wrong (HTTP ${res.status})`, res.status, data);
  return data;
}

export const get = (p) => api("GET", p);
export const post = (p, b = {}) => api("POST", p, b);
export const patch = (p, b = {}) => api("PATCH", p, b);
export const del = (p) => api("DELETE", p);

/** A query string from the values that are set. */
export function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v !== null && v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}
