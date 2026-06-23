const TRANS_PERTH_LIVE_STATUS_BASE =
  "https://www.transperth.wa.gov.au/API/TrainLiveTimes/LiveStatus/GetStationLiveStatusAsync";

const DEFAULT_LINE = "all";
const DEFAULT_LINE_LABEL = "All lines";
const DEFAULT_STATION = "claremont";
const DEFAULT_REFERENCE_STATION = "swanbourne";
const FREMANTLE_DESTINATION = "fremantle";
const CACHE_VERSION = "v3";
const LIVE_STATUS_CACHE_SECONDS = 60;
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
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "Accept, Content-Type",
  "access-control-max-age": "86400"
};

function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
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
  const response = await fetch(url, init);
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
  return error.status === 429 || String(error.body || "").includes("Too Many Requests");
}

async function fetchJsonWithRetry(url, init = {}) {
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchJson(url, init);
    } catch (error) {
      lastError = error;
      if (!shouldRetryTransperth(error) || attempt === 2) {
        throw error;
      }
      await wait(800 * (attempt + 1));
    }
  }

  throw lastError;
}

async function fetchJsonCached(cacheKey, ttlSeconds, url, init = {}) {
  const cache = globalThis.caches && globalThis.caches.default;
  const cacheUrl = `https://transperth-cache.local/${CACHE_VERSION}/${encodeURIComponent(cacheKey)}`;
  const cacheRequest = new Request(cacheUrl);

  if (cache) {
    try {
      const cachedResponse = await cache.match(cacheRequest);
      if (cachedResponse) {
        return cachedResponse.json();
      }
    } catch {
      // Cache failures should not block fresh Transperth data.
    }
  }

  const payload = await fetchJsonWithRetry(url, init);

  if (cache) {
    try {
      const cacheResponse = new Response(JSON.stringify(payload), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": `public, max-age=${ttlSeconds}`
        }
      });
      await cache.put(cacheRequest, cacheResponse);
    } catch {
      // Cache failures should not block fresh Transperth data.
    }
  }

  return payload;
}

async function fetchLiveStatus(line, stationName, includeCancelled) {
  const transperthUrl = [
    TRANS_PERTH_LIVE_STATUS_BASE,
    encodeURIComponent(line),
    encodeURIComponent(stationName),
    String(includeCancelled)
  ].join("/");

  const payload = await fetchJsonCached(
    `live:${line}:${stationName}:${includeCancelled}`,
    LIVE_STATUS_CACHE_SECONDS,
    transperthUrl,
    { headers: TRANS_PERTH_HEADERS }
  );
  if (payload.result !== "success") {
    throw new Error(payload.error || "Transperth did not return live train times.");
  }

  return payload;
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
    const destination = cleanName(service.Destination);
    if (destination === FREMANTLE_DESTINATION) {
      return service;
    }

    const tripId = serviceTripId(service);
    const matchedReferenceTrip = tripId && referenceTripIds.has(tripId);
    const inferredOrigin = matchedReferenceTrip ? referenceOrigin : stationOrigin;

    return {
      ...service,
      InferredOrigin: inferredOrigin,
      OriginInference: matchedReferenceTrip
        ? `Trip ${tripId} also appears at ${referenceStation.StationName}.`
        : `Trip ${tripId || "unknown"} was not returned at ${referenceStation.StationName}.`
    };
  });
}

async function handleRequest(request) {
  const url = new URL(request.url);
  const line = normalizeLineName(url.searchParams.get("line") || DEFAULT_LINE);
  const stationInput = url.searchParams.get("station") || DEFAULT_STATION;
  const referenceStationInput =
    url.searchParams.get("referenceStation") ||
    url.searchParams.get("originCheckStation") ||
    DEFAULT_REFERENCE_STATION;
  const includeCancelled = url.searchParams.get("includeCancelled") === "true";

  try {
    const station = resolveKnownStation(line, stationInput);
    const referenceStation = resolveKnownStation(line, referenceStationInput);

    if (!station) {
      throw new Error(`Unsupported station "${stationInput}".`);
    }

    if (!referenceStation) {
      throw new Error(`Unsupported reference station "${referenceStationInput}".`);
    }

    const stationPayload = await fetchLiveStatus(line, station.StationName, includeCancelled);
    await wait(400);

    let referencePayload = { data: { StatusDetailList: [] } };
    let referenceError = null;
    try {
      referencePayload = await fetchLiveStatus(
        line,
        referenceStation.StationName,
        includeCancelled
      );
    } catch (error) {
      referenceError = error.message || "Reference station lookup failed.";
    }

    const stationData = stationPayload.data || {};
    const referenceData = referencePayload.data || {};
    const services = Array.isArray(stationData.StatusDetailList) ? stationData.StatusDetailList : [];
    const referenceServices = Array.isArray(referenceData.StatusDetailList)
      ? referenceData.StatusDetailList
      : [];

    return jsonResponse({
      ...stationPayload,
      data: {
        ...stationData,
        Station: station.StationName,
        Line: line === "all" ? DEFAULT_LINE_LABEL : line,
        StationLookup: station,
        ReferenceStation: referenceStation.StationName,
        ReferenceStationLookup: referenceStation,
        ReferenceStationError: referenceError,
        StatusDetailList: annotateOrigins(services, referenceServices, station, referenceStation)
      }
    });
  } catch (error) {
    return jsonResponse(
      {
        result: "error",
        error: error.message || "Could not reach Transperth.",
        body: error.body
      },
      { status: error.status || 502 }
    );
  }
}

function debugResponse(request) {
  const url = new URL(request.url);
  return jsonResponse({
    result: "success",
    worker: "ok",
    path: url.pathname,
    search: url.search,
    time: new Date().toISOString()
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const isTrainApiRequest = url.pathname === "/trains/api/trains";
    const isDebugRequest = url.pathname === "/trains/api/debug";

    if (!isTrainApiRequest && !isDebugRequest) {
      return jsonResponse(
        { result: "error", error: "Not found." },
        { status: 404 }
      );
    }

    if (request.method === "OPTIONS") {
      return optionsResponse();
    }

    if (request.method !== "GET") {
      return jsonResponse(
        { result: "error", error: "Method not allowed." },
        { status: 405, headers: { allow: "GET, OPTIONS" } }
      );
    }

    try {
      if (isDebugRequest) {
        return debugResponse(request);
      }

      return handleRequest(request);
    } catch (error) {
      return jsonResponse(
        {
          result: "error",
          error: error.message || "Unexpected Worker error.",
          name: error.name || "Error"
        },
        { status: 500 }
      );
    }
  }
};
