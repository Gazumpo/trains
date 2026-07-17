const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function makeElement() {
  return {
    attributes: {},
    classList: { toggle() {} },
    dataset: {},
    innerHTML: "",
    listeners: {},
    textContent: "",
    addEventListener(type, listener) {
      this.listeners[type] = listener;
    },
    removeAttribute(name) {
      delete this.attributes[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  };
}

function makeLocalStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    }
  };
}

function successfulPayload(fetchedAt = new Date().toISOString()) {
  return {
    result: "success",
    meta: {
      requestId: "request-test",
      workerVersion: "test",
      servedAt: new Date().toISOString(),
      stationDataFetchedAt: fetchedAt,
      upstreamLastUpdatedAt: fetchedAt,
      stationSource: "upstream",
      stationAttempts: 1,
      stationUpstreamDurationMs: 10,
      serviceCount: 2
    },
    data: {
      StatusDetailList: [
        {
          Departure: "10:05",
          Destination: "Fremantle",
          StatusDetail: "On time",
          IsRealTime: true
        },
        {
          Departure: "10:10",
          Destination: "Perth",
          StatusDetail: "On time",
          IsRealTime: true
        }
      ]
    }
  };
}

function createClientContext(payload = successfulPayload()) {
  const html = fs.readFileSync(path.join(root, "trains/index.html"), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map(
    [
      "status",
      "refresh-button",
      "fremantle-list",
      "other-list",
      "diagnostic-state",
      "diagnostic-log"
    ].map((id) => [id, makeElement()])
  );
  const windowListeners = {};
  const documentListeners = {};
  const fetchCalls = [];
  const location = {
    href: "https://example.com/trains/",
    origin: "https://example.com",
    pathname: "/trains/",
    replace() {}
  };
  const window = {
    addEventListener(type, listener) {
      windowListeners[type] = listener;
    },
    clearTimeout,
    crypto: crypto.webcrypto,
    history: { replaceState() {} },
    location,
    matchMedia() {
      return { matches: false };
    },
    navigator: { onLine: true, standalone: false },
    setInterval() {
      return 1;
    },
    setTimeout
  };
  const document = {
    visibilityState: "visible",
    addEventListener(type, listener) {
      documentListeners[type] = listener;
    },
    getElementById(id) {
      return elements.get(id);
    },
    querySelectorAll() {
      return [];
    }
  };
  const silentConsole = { error() {}, log() {}, warn() {} };
  const context = vm.createContext({
    AbortController,
    Date,
    Headers,
    JSON,
    Math,
    Number,
    Promise,
    Response,
    String,
    URL,
    URLSearchParams,
    clearTimeout,
    console: silentConsole,
    crypto: crypto.webcrypto,
    document,
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": payload.meta && payload.meta.requestId || "request-test"
        }
      });
    },
    globalThis: null,
    localStorage: makeLocalStorage(),
    navigator: window.navigator,
    setInterval: window.setInterval,
    setTimeout,
    window
  });
  context.globalThis = context;
  vm.runInContext(script, context, { filename: "trains/index.html" });
  return { context, documentListeners, elements, fetchCalls, windowListeners };
}

function waitForAsyncWork() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("departure times are anchored to the date on which API data was fetched", async () => {
  const { context } = createClientContext();
  await waitForAsyncWork();

  const fetchedAt = Date.parse("2026-07-17T00:05:00+08:00");
  const departure = context.departureTimestamp("23:55", fetchedAt);

  assert.equal(departure, Date.parse("2026-07-16T23:55:00+08:00"));
});

test("services retained from the previous night are removed instead of shown as Now", async () => {
  const { context } = createClientContext();
  await waitForAsyncWork();

  const fetchedAt = Date.parse("2026-07-16T21:00:00+08:00");
  const now = Date.parse("2026-07-17T08:00:00+08:00");
  const services = [
    { Departure: "21:05", Destination: "Perth" },
    { Departure: "21:15", Destination: "Fremantle" }
  ];

  assert.deepEqual(
    Array.from(context.currentFutureServices(services, fetchedAt, now)),
    []
  );
});

test("a stale API response is rejected and old train rows are cleared", async () => {
  const stalePayload = successfulPayload("2026-07-16T21:00:00+08:00");
  const { elements } = createClientContext(stalePayload);
  await waitForAsyncWork();

  assert.equal(elements.get("status").textContent, "Live data unavailable");
  assert.match(elements.get("fremantle-list").innerHTML, /API data is stale/);
  assert.match(elements.get("diagnostic-log").textContent, /api-request-failed/);
});

test("the refresh control remains a native navigation with a unique URL", async () => {
  const { elements } = createClientContext();
  await waitForAsyncWork();

  const refresh = elements.get("refresh-button");
  refresh.listeners.click();

  assert.match(refresh.href, /^https:\/\/example\.com\/trains\/\?appRefresh=\d+$/);
});

test("live-data requests use POST so browser and CDN GET caches cannot replay them", async () => {
  const { fetchCalls } = createClientContext();
  await waitForAsyncWork();

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].init.cache, "no-store");
  assert.match(fetchCalls[0].init.body, /"requestTime":\d+/);
});

function currentPerthTimestamp() {
  const perth = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${pad(perth.getUTCDate())}/${pad(perth.getUTCMonth() + 1)}/${perth.getUTCFullYear()}` +
    ` at ${pad(perth.getUTCHours())}:${pad(perth.getUTCMinutes())}:${pad(perth.getUTCSeconds())}`
  );
}

function createWorkerHarness({ lastUpdated = currentPerthTimestamp() } = {}) {
  const original = fs.readFileSync(
    path.join(root, "worker/trains-api-worker.js"),
    "utf8"
  );
  const source = original.replace("export default {", "globalThis.workerDefault = {");
  const cacheEntries = new Map();
  const waitUntilPromises = [];
  const logs = [];
  const upstreamUrls = [];
  const context = vm.createContext({
    AbortSignal,
    Date,
    Error,
    Headers,
    JSON,
    Map,
    Promise,
    Request,
    Response,
    Set,
    String,
    URL,
    console: {
      error(value) {
        logs.push(value);
      },
      log(value) {
        logs.push(value);
      },
      warn(value) {
        logs.push(value);
      }
    },
    crypto: crypto.webcrypto,
    fetch: async (url) => {
      upstreamUrls.push(String(url));
      const station = String(url).includes("Swanbourne") ? "Swanbourne" : "Claremont";
      return new Response(
        JSON.stringify({
          result: "success",
          data: {
            LastUpdated: lastUpdated,
            StatusDetailList: [
              {
                TripId: station === "Swanbourne" ? "trip-1" : "trip-1",
                Departure: "10:05",
                Destination: "Perth"
              }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    },
    globalThis: null,
    setTimeout() {
      return 1;
    }
  });
  context.globalThis = context;
  context.caches = {
    default: {
      async match(request) {
        const cached = cacheEntries.get(request.url);
        return cached ? cached.clone() : undefined;
      },
      async put(request, response) {
        cacheEntries.set(request.url, response.clone());
      }
    }
  };
  vm.runInContext(source, context, { filename: "trains-api-worker.js" });

  return {
    cacheEntries,
    context,
    logs,
    upstreamUrls,
    worker: context.workerDefault,
    workerContext: {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      }
    },
    async settleWaitUntil() {
      for (let index = 0; index < waitUntilPromises.length; index += 1) {
        await waitUntilPromises[index];
      }
    }
  };
}

test("Worker converts delayed departures across midnight to an absolute timestamp", () => {
  const harness = createWorkerHarness();
  const departureAt = harness.context.serviceDepartureAt({
    Departure: "00:04",
    TripStopSchedule: "17/07/2026 23:59:00"
  });

  assert.equal(departureAt, "2026-07-17T16:04:00.000Z");
});

test("Worker responses expose freshness, provenance, and a correlating request ID", async () => {
  const harness = createWorkerHarness();
  const response = await harness.worker.fetch(
    new Request(
      "https://example.com/trains/api/trains?station=claremont&referenceStation=swanbourne&fresh=true",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }
    ),
    {},
    harness.workerContext
  );
  const payload = await response.json();
  await harness.settleWaitUntil();

  assert.equal(response.status, 200);
  assert.equal(payload.result, "success");
  assert.equal(payload.meta.stationSource, "upstream-bypass");
  assert.equal(payload.meta.serviceCount, 1);
  assert.ok(Number.isFinite(Date.parse(payload.meta.stationDataFetchedAt)));
  assert.equal(response.headers.get("x-request-id"), payload.meta.requestId);
  assert.equal(response.headers.get("cloudflare-cdn-cache-control"), "no-store");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(harness.upstreamUrls.length, 2);
  assert.ok(
    harness.logs.some((line) => JSON.parse(line).event === "train-request-complete")
  );
});

test("Worker rejects an upstream payload whose own LastUpdated value is stale", async () => {
  const harness = createWorkerHarness({
    lastUpdated: "16/07/2026 at 21:00:00"
  });
  const response = await harness.worker.fetch(
    new Request(
      "https://example.com/trains/api/trains?station=claremont&referenceStation=swanbourne&fresh=true"
    ),
    {},
    harness.workerContext
  );
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.result, "error");
  assert.match(payload.error, /stale data/);
});

test("Worker cache hits retain the original fetch timestamp and avoid upstream calls", async () => {
  const harness = createWorkerHarness();
  const url =
    "https://example.com/trains/api/trains?station=claremont&referenceStation=swanbourne";

  const firstResponse = await harness.worker.fetch(
    new Request(url),
    {},
    harness.workerContext
  );
  await firstResponse.json();
  await harness.settleWaitUntil();
  const upstreamCallsAfterFirstRequest = harness.upstreamUrls.length;

  const secondResponse = await harness.worker.fetch(
    new Request(url),
    {},
    harness.workerContext
  );
  const secondPayload = await secondResponse.json();

  assert.equal(secondPayload.meta.stationSource, "cache");
  assert.equal(harness.upstreamUrls.length, upstreamCallsAfterFirstRequest);
});
