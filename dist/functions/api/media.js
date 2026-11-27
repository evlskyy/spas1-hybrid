const SUPABASE_URL = "https://kgmmbjcpztioelowwdra.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Cs2hp-afSUSdalvJbH6PAw_wtTvMSnh";
const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000001";
const BUCKETS = {
  "spas1-media": {
    publicRead: true,
    maxBytes: 10 * 1024 * 1024,
    contentTypes: new Set(["image/jpeg", "image/png", "image/webp", "image/gif"])
  },
  "spas1-lpdh": {
    publicRead: false,
    maxBytes: 10 * 1024 * 1024,
    contentTypes: new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"])
  },
  "spas1-finance": {
    publicRead: false,
    maxBytes: 10 * 1024 * 1024,
    contentTypes: new Set(["image/jpeg", "image/png", "image/webp"])
  }
};

function jsonResponse(payload, status, extraHeaders) {
  const headers = new Headers(extraHeaders || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(payload), { status: status, headers: headers });
}

function parseObjectPath(value) {
  if (!value || value.length > 1024 || value.startsWith("/") || /[\\\u0000-\u001f\u007f?#]/.test(value)) return null;
  const segments = value.split("/");
  if (segments.length < 2 || segments.length > 16 ||
      segments.some(function(segment) { return !segment || segment === "." || segment === ".." || segment.length > 255; })) return null;
  const first = segments[0];
  if (first !== "spas1" && !TENANT_ID_PATTERN.test(first)) return null;
  return segments;
}

function accessToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : "";
}

async function resolveUser(request) {
  const token = accessToken(request);
  if (!token) return { response: jsonResponse({ error: "Authentication required." }, 401) };
  let response;
  try {
    response = await fetch(SUPABASE_URL + "/auth/v1/user", {
      method: "GET",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": "Bearer " + token,
        "Accept": "application/json"
      },
      redirect: "manual",
      cache: "no-store"
    });
  } catch (_) {
    return { response: jsonResponse({ error: "Authentication service unavailable." }, 502) };
  }
  if (!response.ok || response.status >= 300) {
    return { response: jsonResponse({ error: "Authentication failed." }, response.status === 429 ? 429 : 401) };
  }
  let user;
  try {
    user = await response.json();
  } catch (_) {
    return { response: jsonResponse({ error: "Authentication response invalid." }, 502) };
  }
  const tenantId = user && user.app_metadata && user.app_metadata.sppg_id;
  if (typeof tenantId !== "string" || !TENANT_ID_PATTERN.test(tenantId)) {
    return { response: jsonResponse({ error: "Authenticated tenant is invalid." }, 403) };
  }
  return {
    token: token,
    storageFolder: tenantId.toLowerCase() === DEMO_TENANT_ID ? "spas1" : tenantId.toLowerCase()
  };
}

function responseHeaders(upstream, isPublic) {
  const headers = new Headers();
  ["Content-Type", "Content-Disposition", "ETag", "Last-Modified"].forEach(function(name) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  });
  headers.set("Cache-Control", isPublic ? "public, max-age=300" : "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export async function onRequest({ request }) {
  const method = request.method.toUpperCase();
  if (!["GET", "POST", "DELETE"].includes(method)) {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET, POST, DELETE" });
  }
  const query = new URL(request.url).searchParams;
  const bucket = query.get("bucket");
  const bucketConfig = BUCKETS[bucket];
  if (!bucketConfig) return jsonResponse({ error: "Media bucket not allowed." }, 400);
  const objectPath = query.get("path") || "";
  const pathSegments = parseObjectPath(objectPath);
  if (!pathSegments) return jsonResponse({ error: "Media path invalid." }, 400);

  const access = query.get("access") || "public";
  if (!["public", "authenticated"].includes(access)) return jsonResponse({ error: "Access mode invalid." }, 400);
  const isPublicRead = method === "GET" && access === "public" && bucketConfig.publicRead;
  if (method === "GET" && !isPublicRead && access !== "authenticated") {
    return jsonResponse({ error: "Authentication required." }, 401);
  }
  if (method !== "GET" && access !== "public") {
    return jsonResponse({ error: "Access mode invalid." }, 400);
  }

  let userContext = null;
  if (!isPublicRead) {
    userContext = await resolveUser(request);
    if (userContext.response) return userContext.response;
    if (pathSegments[0].toLowerCase() !== userContext.storageFolder) {
      return jsonResponse({ error: "Media path is outside the authenticated tenant." }, 403);
    }
  }

  const upstreamPath = "/storage/v1/object/" +
    (isPublicRead ? "public/" : "") +
    bucket + "/" + pathSegments.map(encodeURIComponent).join("/");
  const upstreamHeaders = new Headers({
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": "Bearer " + (userContext ? userContext.token : SUPABASE_ANON_KEY)
  });

  if (method === "POST") {
    const contentType = (request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    const rawContentLength = request.headers.get("Content-Length") || "";
    const contentLength = Number(rawContentLength);
    if (!bucketConfig.contentTypes.has(contentType)) return jsonResponse({ error: "Media type not allowed." }, 415);
    if (!/^\d+$/.test(rawContentLength) || !Number.isSafeInteger(contentLength) ||
        contentLength < 1 || contentLength > bucketConfig.maxBytes) {
      return jsonResponse({ error: "Media size is invalid or exceeds the limit." }, 413);
    }
    upstreamHeaders.set("Content-Type", contentType);
    const upsert = request.headers.get("x-upsert");
    if (upsert === "true" || upsert === "false") upstreamHeaders.set("x-upsert", upsert);
  }

  let upstream;
  try {
    upstream = await fetch(SUPABASE_URL + upstreamPath, {
      method: method,
      headers: upstreamHeaders,
      body: method === "POST" ? request.body : undefined,
      redirect: "manual",
      cache: "no-store"
    });
  } catch (_) {
    return jsonResponse({ error: "Media storage unavailable." }, 502);
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    return jsonResponse({ error: "Media storage returned an unexpected redirect." }, 502);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: "Media storage request failed." }, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
  }
  if (method === "GET") {
    const contentType = (upstream.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!bucketConfig.contentTypes.has(contentType)) {
      return jsonResponse({ error: "Media storage returned an unsupported content type." }, 502);
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, isPublicRead)
  });
}
