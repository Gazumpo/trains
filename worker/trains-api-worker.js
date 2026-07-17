const TRANS_PERTH_LIVE_STATUS_BASE =
  "https://www.transperth.wa.gov.au/API/TrainLiveTimes/LiveStatus/GetStationLiveStatusAsync";

const DEFAULT_LINE = "all";
const DEFAULT_LINE_LABEL = "All lines";
const DEFAULT_STATION = "claremont";
const DEFAULT_REFERENCE_STATION = "swanbourne";
const FREMANTLE_DESTINATION = "fremantle";
const WORKER_VERSION = "2026-07-17.2";
const CACHE_VERSION = "v4";
const LIVE_STATUS_CACHE_SECONDS = 60;
const UPSTREAM_TIMEOUT_MS = 6000;
const PRIMARY_MAX_ATTEMPTS = 2;
const REFERENCE_MAX_ATTEMPTS = 1;
const REFERENCE_LOOKUP_BUDGET_MS = 1800;
const MAX_UPSTREAM_DATA_AGE_MS = 180000;
const PERTH_UTC_OFFSET_HOURS = 8;
const KNOWN_ALL_LINE_STATIONS = [
  { Id: 90, StationName: "Claremont Stn", Code: "CLA" },
  { Id: 142, StationName: "Swanbourne Stn", Code: "SBN" }
];
const TRANS_PERTH_HEADERS = {
  ModuleId: "5111",
  TabId: "248",
  Accept: "application/json, text/plain, */*",
  Origin: "http://transnet",
  Referer: "https://www.transperth.wa.gov.au/",
  "X-Requested-With": "XMLHttpRequest"
};
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-expose-headers": "X-Request-Id",
  "access-control-max-age": "86400"
};

function logWorker(level, event, details = {}) {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    workerVersion: WORKER_VERSION,
    event,
    ...details
  });
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.log(entry);
  }
}

function jsonResponse(body, init = {}, requestId = "") {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set(
    "cache-control",
    "private, no-store, no-cache, max-age=0, must-revalidate"
  );
  headers.set("cloudflare-cdn-cache-control", "no-store");
  headers.set("cdn-cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  if (requestId) headers.set("x-request-id", requestId);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
}

function cleanName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(stn|station)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function displayStationName(value) {
  return String(value || "").replace(/\s+Stn$/i, "");
}

function parsePerthDateTime(value) {
  const match =
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+at)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      String(value || "").trim()
    );
  if (!match) return null;

  const timestamp = Date.UTC(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4]) - PERTH_UTC_OFFSET_HOURS,
    Number(match[5]),
    Number(match[6] || 0)
  );
  return Number.isFinite(timestamp) ? timestamp : null;
}

function serviceDepartureAt(service) {
  const scheduledAt = parsePerthDateTime(service && service.TripStopSchedule);
  const departureMatch = /^(\d{1,2}):(\d{2})$/.exec(
    String(service && service.Departure || "")
  );
  if (scheduledAt == null || !departureMatch) return null;

  const scheduledPerth = new Date(scheduledAt + PERTH_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  let departureAt = Date.UTC(
    scheduledPerth.getUTCFullYear(),
    scheduledPerth.getUTCMonth(),
    scheduledPerth.getUTCDate(),
    Number(departureMatch[1]) - PERTH_UTC_OFFSET_HOURS,
    Number(departureMatch[2])
  );
  const differenceFromSchedule = departureAt - scheduledAt;
  if (differenceFromSchedule > 12 * 60 * 60 * 1000) {
    departureAt -= 24 * 60 * 60 * 1000;
  } else if (differenceFromSchedule < -12 * 60 * 60 * 1000) {
    departureAt += 24 * 60 * 60 * 1000;
  }

  return new Date(departureAt).toISOString();
}

function normalizeLineName(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return DEFAULT_LINE;
  if (/^all$/i.test(trimmed)) return "all";
  return /\bline$/i.test(trimmed) ? trimmed : `${trimmed} Line`;
}

function stationCandidates(station) {
  return [station.StationName, station.Code, station.Id].map(cleanName).filter(Boolean);
}

function resolveStation(stations, input) {
  const wanted = cleanName(input);
  const exact = stations.find((station) => stationCandidates(station).includes(wanted));
  if (exact) return exact;

  const startsWith = stations.find((station) =>
    stationCandidates(station).some((candidate) => candidate.startsWith(wanted))
  );
  if (startsWith) return startsWith;

  const contains = stations.find((station) =>
    stationCandidates(station).some((candidate) => candidate.includes(wanted))
  );
  if (contains) return contains;

  throw new Error(`Could not find station "${input}" on this line.`);
}

function resolveKnownStation(line, input) {
  if (line !== "all") return null;

  try {
    return resolveStation(KNOWN_ALL_LINE_STATIONS, input);
  } catch {
    return null;
  }
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
  const text = await response.text();

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const error = new Error("Transperth returned a non-JSON response.");
    error.status = 502;
    error.body = text;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(payload.error || payload.Message || "Transperth request failed.");
    error.status = response.status;
    error.body = payload;
    throw error;
  }

  return payload;
}

function shouldRetryTransperth(error) {
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    error.status === 429 ||
    error.status >= 500 ||
    String(error.body || "").includes("Too Many Requests")
  );
}

async function fetchJsonWithRetry(url, init = {}, maxAttempts = PRIMARY_MAX_ATTEMPTS) {
  let lastError;
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await fetchJson(url, init);
      return {
        payload,
        attempts: attempt,
        upstreamDurationMs: Date.now() - startedAt
      };
    } catch (error) {
      lastError = error;
      if (!shouldRetryTransperth(error) || attempt === maxAttempts) {
        throw error;
      }
      await wait(500 * attempt);
    }
  }

  throw lastError;
}

async function fetchJsonCached({
  cacheKey,
  ttlSeconds,
  url,
  init = {},
  bypassCache = false,
  maxAttempts = PRIMARY_MAX_ATTEMPTS,
  requestId,
  ctx
}) {
  const cache = globalThis.caches && globalThis.caches.default;
  const cacheUrl = `https://transperth-cache.local/${CACHE_VERSION}/${encodeURIComponent(cacheKey)}`;
  const cacheRequest = new Request(cacheUrl);

  if (cache && !bypassCache) {
    try {
      const cachedResponse = await cache.match(cacheRequest);
      if (cachedResponse) {
        const cached = await cachedResponse.json();
        const fetchedAtMs = Date.parse(cached.fetchedAt);
        if (cached.payload && Number.isFinite(fetchedAtMs)) {
          const cacheAgeMs = Math.max(0, Date.now() - fetchedAtMs);
          if (cacheAgeMs > ttlSeconds * 1000 + 5000) {
            logWorker("warn", "stale-cache-ignored", {
              requestId,
              cacheKey,
              cacheAgeMs
            });
          } else {
            return {
              payload: cached.payload,
              source: "cache",
              fetchedAt: cached.fetchedAt,
              cacheAgeMs,
              attempts: 0,
              upstreamDurationMs: 0
            };
          }
        }
      }
    } catch (error) {
      logWorker("warn", "cache-read-failed", {
        requestId,
        cacheKey,
        error: error.message || String(error)
      });
    }
  }

  const upstream = await fetchJsonWithRetry(url, init, maxAttempts);
  const fetchedAt = new Date().toISOString();

  if (cache) {
    const cacheWrite = async () => {
      const cacheResponse = new Response(JSON.stringify({ fetchedAt, payload: upstream.payload }), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttlSeconds}`
        }
      });
      await cache.put(cacheRequest, cacheResponse);
    };
    const cacheWriteWithLogging = cacheWrite().catch((error) => {
      logWorker("warn", "cache-write-failed", {
        requestId,
        cacheKey,
        error: error.message || String(error)
      });
    });

    if (ctx) {
      ctx.waitUntil(cacheWriteWithLogging);
    } else {
      await cacheWriteWithLogging;
    }
  }

  return {
    payload: upstream.payload,
    source: bypassCache ? "upstream-bypass" : "upstream",
    fetchedAt,
    cacheAgeMs: 0,
    attempts: upstream.attempts,
    upstreamDurationMs: upstream.upstreamDurationMs
  };
}

async function fetchLiveStatus({
  line,
  stationName,
  includeCancelled,
  bypassCache,
  maxAttempts,
  requestId,
  ctx
}) {
  const transperthUrl = [
    TRANS_PERTH_LIVE_STATUS_BASE,
    encodeURIComponent(line),
    encodeURIComponent(stationName),
    String(includeCancelled)
  ].join("/");

  const result = await fetchJsonCached({
    cacheKey: `live:${line}:${stationName}:${includeCancelled}`,
    ttlSeconds: LIVE_STATUS_CACHE_SECONDS,
    url: transperthUrl,
    init: { headers: TRANS_PERTH_HEADERS },
    bypassCache,
    maxAttempts,
    requestId,
    ctx
  });
  if (result.payload.result !== "success") {
    throw new Error(
      result.payload.error || "Transperth did not return live train times."
    );
  }

  return result;
}

function serviceTripId(service) {
  if (!service || service.TripId == null) return "";
  return String(service.TripId);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function annotateOrigins(services, referenceServices, station, referenceStation) {
  const referenceTripIds = new Set(referenceServices.map(serviceTripId).filter(Boolean));
  const stationOrigin = displayStationName(station.StationName);
  const referenceOrigin = "Fremantle";

  return services.map((service) => {
    const annotatedService = {
      ...service,
      DepartureAt: serviceDepartureAt(service)
    };
    const destination = cleanName(service.Destination);
    if (destination === FREMANTLE_DESTINATION) {
      return annotatedService;
    }

    const tripId = serviceTripId(service);
    const matchedReferenceTrip = tripId && referenceTripIds.has(tripId);
    const inferredOrigin = matchedReferenceTrip ? referenceOrigin : stationOrigin;

    return {
      ...annotatedService,
      InferredOrigin: inferredOrigin,
      OriginInference: matchedReferenceTrip
        ? `Trip ${tripId} also appears at ${referenceStation.StationName}.`
        : `Trip ${tripId || "unknown"} was not returned at ${referenceStation.StationName}.`
    };
  });
}

async function handleRequest(request, requestId, ctx) {
  const url = new URL(request.url);
  const requestStartedAt = Date.now();
  const line = normalizeLineName(url.searchParams.get("line") || DEFAULT_LINE);
  const stationInput = url.searchParams.get("station") || DEFAULT_STATION;
  const referenceStationInput =
    url.searchParams.get("referenceStation") ||
    url.searchParams.get("originCheckStation") ||
    DEFAULT_REFERENCE_STATION;
  const includeCancelled = url.searchParams.get("includeCancelled") === "true";
  const bypassCache =
    url.searchParams.get("fresh") === "true" ||
    url.searchParams.get("fresh") === "1";

  try {
    const station = resolveKnownStation(line, stationInput);
    const referenceStation = resolveKnownStation(line, referenceStationInput);

    if (!station) {
      throw new Error(`Unsupported station "${stationInput}".`);
    }

    if (!referenceStation) {
      throw new Error(`Unsupported reference station "${referenceStationInput}".`);
    }

    const stationResult = await fetchLiveStatus({
      line,
      stationName: station.StationName,
      includeCancelled,
      bypassCache,
      maxAttempts: PRIMARY_MAX_ATTEMPTS,
      requestId,
      ctx
    });
    let referenceResult = {
      payload: { data: { StatusDetailList: [] } },
      source: "unavailable",
      fetchedAt: null,
      cacheAgeMs: null,
      attempts: 0,
      upstreamDurationMs: 0
    };
    let referenceError = null;
    const referenceLookup = fetchLiveStatus({
      line,
      stationName: referenceStation.StationName,
      includeCancelled,
      bypassCache: false,
      maxAttempts: REFERENCE_MAX_ATTEMPTS,
      requestId,
      ctx: null
    });
    if (ctx) {
      ctx.waitUntil(
        referenceLookup.then(() => undefined).catch((error) => {
          logWorker("warn", "reference-station-background-failed", {
            requestId,
            station: referenceStation.StationName,
            error: error.message || String(error)
          });
        })
      );
    }

    try {
      referenceResult = await Promise.race([
        referenceLookup,
        wait(REFERENCE_LOOKUP_BUDGET_MS).then(() => {
          const error = new Error(
            `Reference station lookup exceeded ${REFERENCE_LOOKUP_BUDGET_MS}ms budget.`
          );
          error.name = "ReferenceTimeoutError";
          throw error;
        })
      ]);
    } catch (error) {
      referenceError = error.message || "Reference station lookup failed.";
      if (error.name === "ReferenceTimeoutError") {
        referenceResult.source = "timeout";
      }
      logWorker("warn", "reference-station-failed", {
        requestId,
        station: referenceStation.StationName,
        error: referenceError
      });
    }

    const stationPayload = stationResult.payload;
    const referencePayload = referenceResult.payload;
    const stationData = stationPayload.data || {};
    const referenceData = referencePayload.data || {};
    const upstreamLastUpdatedAtMs = parsePerthDateTime(stationData.LastUpdated);
    if (upstreamLastUpdatedAtMs == null) {
      const error = new Error("Transperth response has no valid LastUpdated timestamp.");
      error.status = 502;
      throw error;
    }
    const upstreamDataAgeMs = Date.now() - upstreamLastUpdatedAtMs;
    if (upstreamDataAgeMs < -60000 || upstreamDataAgeMs > MAX_UPSTREAM_DATA_AGE_MS) {
      const error = new Error(
        upstreamDataAgeMs < 0
          ? "Transperth response timestamp is unexpectedly in the future."
          : `Transperth returned stale data (${Math.round(upstreamDataAgeMs / 1000)}s old).`
      );
      error.status = 502;
      throw error;
    }

    const services = Array.isArray(stationData.StatusDetailList) ? stationData.StatusDetailList : [];
    const referenceServices = Array.isArray(referenceData.StatusDetailList)
      ? referenceData.StatusDetailList
      : [];
    const servedAt = new Date().toISOString();
    const responseMeta = {
      requestId,
      workerVersion: WORKER_VERSION,
      servedAt,
      stationDataFetchedAt: stationResult.fetchedAt,
      stationDataAgeMs: stationResult.cacheAgeMs,
      upstreamLastUpdated: stationData.LastUpdated,
      upstreamLastUpdatedAt: new Date(upstreamLastUpdatedAtMs).toISOString(),
      upstreamDataAgeMs: Math.max(0, upstreamDataAgeMs),
      stationSource: stationResult.source,
      stationAttempts: stationResult.attempts,
      stationUpstreamDurationMs: stationResult.upstreamDurationMs,
      referenceDataFetchedAt: referenceResult.fetchedAt,
      referenceSource: referenceResult.source,
      referenceAttempts: referenceResult.attempts,
      referenceUpstreamDurationMs: referenceResult.upstreamDurationMs,
      referenceError,
      bypassCache,
      serviceCount: services.length,
      durationMs: Date.now() - requestStartedAt
    };

    logWorker(services.length ? "log" : "warn", "train-request-complete", {
      ...responseMeta,
      station: station.StationName
    });

    return jsonResponse(
      {
        ...stationPayload,
        meta: responseMeta,
        data: {
          ...stationData,
          Station: station.StationName,
          Line: line === "all" ? DEFAULT_LINE_LABEL : line,
          StationLookup: station,
          ReferenceStation: referenceStation.StationName,
          ReferenceStationLookup: referenceStation,
          ReferenceStationError: referenceError,
          StatusDetailList: annotateOrigins(
            services,
            referenceServices,
            station,
            referenceStation
          )
        }
      },
      {},
      requestId
    );
  } catch (error) {
    const status = error.status || 502;
    logWorker("error", "train-request-failed", {
      requestId,
      status,
      durationMs: Date.now() - requestStartedAt,
      bypassCache,
      error: error.message || String(error),
      name: error.name || "Error"
    });

    return jsonResponse(
      {
        result: "error",
        error: error.message || "Could not reach Transperth.",
        meta: {
          requestId,
          workerVersion: WORKER_VERSION,
          servedAt: new Date().toISOString(),
          bypassCache,
          durationMs: Date.now() - requestStartedAt
        }
      },
      { status },
      requestId
    );
  }
}

function debugResponse(request, requestId) {
  const url = new URL(request.url);
  return jsonResponse(
    {
      result: "success",
      worker: "ok",
      workerVersion: WORKER_VERSION,
      requestId,
      path: url.pathname,
      search: url.search,
      time: new Date().toISOString()
    },
    {},
    requestId
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const requestId = crypto.randomUUID();
    const isTrainApiRequest = url.pathname === "/trains/api/trains";
    const isDebugRequest = url.pathname === "/trains/api/debug";

    if (!isTrainApiRequest && !isDebugRequest) {
      return jsonResponse(
        { result: "error", error: "Not found." },
        { status: 404 },
        requestId
      );
    }

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    const methodAllowed =
      (isTrainApiRequest && (request.method === "GET" || request.method === "POST")) ||
      (isDebugRequest && request.method === "GET");
    if (!methodAllowed) {
      return jsonResponse(
        { result: "error", error: "Method not allowed." },
        {
          status: 405,
          headers: {
            allow: isTrainApiRequest ? "GET, POST, OPTIONS" : "GET, OPTIONS"
          }
        },
        requestId
      );
    }

    try {
      if (isDebugRequest) {
        return debugResponse(request, requestId);
      }

      return handleRequest(request, requestId, ctx);
    } catch (error) {
      logWorker("error", "unhandled-request-error", {
        requestId,
        error: error.message || String(error),
        name: error.name || "Error"
      });
      return jsonResponse(
        {
          result: "error",
          error: error.message || "Unexpected Worker error.",
          name: error.name || "Error",
          meta: {
            requestId,
            workerVersion: WORKER_VERSION,
            servedAt: new Date().toISOString()
          }
        },
        { status: 500 },
        requestId
      );
    }
  }
};
