const upstreamOrigin = "https://wilayah.id/api";
const cacheControl = "public, max-age=86400, stale-while-revalidate=604800";

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": cacheControl,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function getRegionRequest(url) {
  const level = url.searchParams.get("level");
  const parentCode = url.searchParams.get("parentCode");
  if (level === "provinces" && parentCode === null) {
    return { level, url: upstreamOrigin + "/provinces.json" };
  }
  if (level === "regencies" && parentCode && /^\d{2}$/.test(parentCode)) {
    return { level, parentCode, url: upstreamOrigin + "/regencies/" + parentCode + ".json" };
  }
  if (level === "districts" && parentCode && /^\d{2}\.\d{2}$/.test(parentCode)) {
    return {
      level,
      parentCode,
      url: upstreamOrigin + "/districts/" + encodeURIComponent(parentCode) + ".json"
    };
  }
  return null;
}

function normalizeRegions(payload, level, parentCode) {
  if (!payload || !Array.isArray(payload.data) || payload.data.length === 0) return null;
  const codePattern = level === "provinces"
    ? /^\d{2}$/
    : level === "regencies"
    ? /^\d{2}\.\d{2}$/
    : /^\d{2}\.\d{2}\.\d{2}$/;
  const seenCodes = new Set();
  const regions = [];
  for (const item of payload.data) {
    if (!item || typeof item.code !== "string" || typeof item.name !== "string") return null;
    const code = item.code.trim();
    const name = item.name.trim();
    if (!codePattern.test(code) || !name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) return null;
    if (level !== "provinces" && !code.startsWith(parentCode + ".")) return null;
    if (seenCodes.has(code)) return null;
    seenCodes.add(code);
    regions.push({ code, name });
  }
  return regions;
}

export async function onRequestGet({ request }) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405, { Allow: "GET" });
  }
  const regionRequest = getRegionRequest(new URL(request.url));
  if (!regionRequest) return jsonResponse({ error: "Permintaan wilayah tidak valid." }, 400);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(regionRequest.url, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal
    });
  } catch (error) {
    console.error("Wilayah source request failed:", error instanceof Error ? error.message : "Unknown error");
    const status = error instanceof Error && error.name === "AbortError" ? 504 : 502;
    return jsonResponse({ error: "Sumber data wilayah sementara tidak tersedia." }, status);
  } finally {
    clearTimeout(timeout);
  }
  if (!upstreamResponse.ok) {
    console.error("Wilayah source returned HTTP", upstreamResponse.status);
    return jsonResponse({
      error: "Sumber data wilayah sementara tidak tersedia.",
      upstreamStatus: upstreamResponse.status
    }, 502);
  }

  let payload;
  try {
    payload = await upstreamResponse.json();
  } catch (error) {
    console.error("Wilayah source returned invalid JSON:", error instanceof Error ? error.message : "Unknown error");
    return jsonResponse({ error: "Sumber data wilayah mengirim respons yang tidak valid." }, 502);
  }
  const regions = normalizeRegions(payload, regionRequest.level, regionRequest.parentCode);
  if (!regions) {
    console.error("Wilayah source returned an invalid region list.");
    return jsonResponse({ error: "Sumber data wilayah mengirim daftar yang tidak valid." }, 502);
  }

  return jsonResponse({
    data: regions,
    source: "wilayah.id",
    updatedAt: typeof payload.meta?.updated_at === "string" ? payload.meta.updated_at : ""
  }, 200);
}
