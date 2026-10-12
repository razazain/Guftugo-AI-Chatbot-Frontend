const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "http://localhost:5000/api/v1").replace(/\/$/, "");
const ACCESS_KEY = "guftugo.accessToken";
const REFRESH_KEY = "guftugo.refreshToken";
let refreshInFlight = null;

export function getStoredTokens() {
  return {
    accessToken: localStorage.getItem(ACCESS_KEY) || "",
    refreshToken: localStorage.getItem(REFRESH_KEY) || "",
  };
}

export function storeTokens({ accessToken, refreshToken }) {
  if (accessToken) localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearStoredTokens() {
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

function errorFrom(payload, status) {
  const error = new Error(payload?.error?.message || payload?.message || `Request failed (${status}).`);
  error.status = status;
  error.code = payload?.error?.code || "REQUEST_FAILED";
  error.details = payload?.error?.details;
  return error;
}

async function readPayload(response) {
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    try { return await response.json(); } catch { return {}; }
  }
  const text = await response.text().catch(() => "");
  return text ? { message: text } : {};
}

async function refreshSession() {
  if (refreshInFlight) return refreshInFlight;
  const { refreshToken } = getStoredTokens();
  if (!refreshToken) throw new Error("Your session has expired. Please sign in again.");
  refreshInFlight = (async () => {
    try {
      const payload = await apiRequest("/auth/refresh", {
        method: "POST", body: { refreshToken }, auth: false, retryAuth: false,
      });
      if (!payload?.data?.accessToken || !payload?.data?.refreshToken) {
        throw new Error("Your session could not be refreshed. Please sign in again.");
      }
      storeTokens(payload.data);
      return payload.data;
    } catch (error) {
      clearStoredTokens();
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function apiRequest(path, options = {}) {
  const { auth = true, retryAuth = true, ...requestOptions } = options;
  const url = `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(requestOptions.headers || {});
  const bodyIsForm = typeof FormData !== "undefined" && requestOptions.body instanceof FormData;
  let body = requestOptions.body;
  if (body !== undefined && body !== null && !bodyIsForm && typeof body !== "string" && !(body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }
  if (auth) {
    const { accessToken } = getStoredTokens();
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  }
  let response;
  try {
    response = await fetch(url, { ...requestOptions, body, headers });
  } catch {
    throw new Error("Could not connect to Guftugo. Check that the backend is running and VITE_API_BASE_URL is correct.");
  }
  const authExcluded = ["/auth/login", "/auth/register", "/auth/refresh"].some((p) => path.startsWith(p));
  if (response.status === 401 && auth && retryAuth && !authExcluded && getStoredTokens().refreshToken) {
    try {
      await refreshSession();
      return apiRequest(path, { ...options, retryAuth: false });
    } catch (error) {
      throw error;
    }
  }
  const payload = await readPayload(response);
  if (!response.ok || payload?.success === false) throw errorFrom(payload, response.status);
  return payload;
}

export async function apiStream(path, body, signal) {
  const send = async () => {
    const { accessToken } = getStoredTokens();
    const headers = new Headers({ "Content-Type": "application/json", Accept: "text/event-stream" });
    if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
    try {
      return await fetch(`${API_BASE_URL}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new Error("Could not connect to Guftugo. Check the backend server and API URL.");
    }
  };
  let response = await send();
  if (response.status === 401 && getStoredTokens().refreshToken) {
    await refreshSession();
    response = await send();
  }
  if (!response.ok) {
    const payload = await readPayload(response);
    throw errorFrom(payload, response.status);
  }
  if (!response.body) throw new Error("Streaming is not supported by this response. Please try again.");
  return response;
}

export function getApiBaseUrl() { return API_BASE_URL; }
