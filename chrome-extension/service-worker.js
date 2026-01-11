const POLL_ALARM = "poll-blocked-tasks";
const MIN_CAPTURE_INTERVAL_MS = 1200;
let lastCaptureTime = 0;
let captureQueue = Promise.resolve();
const PROXY_BASE_URL = "http://localhost:8787";
const BACKEND_BASE_URL = "http://localhost:8080";
const HISTORY_DAYS = 7;
const MAX_HISTORY_ITEMS = 2000;
const MAX_HOSTS = 25;
const MAX_SAMPLE_URLS_PER_HOST = 4;
const MAX_STEP_HISTORY_ITEMS = 300;

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 15 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollBlockedTasks();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) {
    return;
  }
  if (!isInjectableUrl(tab.url)) {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay" });
  } catch (error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-script.js"]
      });
      await chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay" });
    } catch (scriptError) {
      // Swallow errors from restricted pages or tabs that disallow injection.
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "poll-blocked") {
    pollBlockedTasks().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "discover-hosts") {
    discoverHosts().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "capture-workspace") {
    captureWorkspace().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "capture-screenshot") {
    captureScreenshots().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "capture-viewport") {
    captureViewport().then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "ANALYZE_WORKFLOW_SITES") {
    analyzeWorkflowSites(message?.taskDescription)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "ANALYZE_WORKFLOW_STEPS") {
    analyzeWorkflowSteps(message?.taskDescription, message?.workflowHosts)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "submit-task") {
    // Stubbed backend call.
    sendResponse({ ok: true, taskId: crypto.randomUUID() });
    return true;
  }

  if (message?.type === "submit-workflow-steps") {
    submitWorkflowSteps(message?.payload).then((result) => sendResponse(result));
    return true;
  }

  if (message?.type === "revoke-auth") {
    // Stubbed backend delete.
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function pollBlockedTasks() {
  // Placeholder for backend poll or push fallback.
  return { ok: true, blockedTasks: [] };
}

async function submitWorkflowSteps(payload) {
  if (!payload) {
    return { ok: false, error: "Missing workflow payload" };
  }

  const idempotencyKey = crypto.randomUUID();
  const response = await fetch(`${BACKEND_BASE_URL}/workflows`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      ok: false,
      error: json?.detail || json?.error || `Backend error (${response.status})`
    };
  }

  return { ok: true, workflow: json };
}

async function discoverHosts() {
  const now = Date.now();
  const startTime = now - 24 * 60 * 60 * 1000;
  const historyItems = await chrome.history.search({
    text: "",
    startTime,
    maxResults: 500
  });

  const openTabs = await chrome.tabs.query({});
  const openHosts = new Set(
    openTabs
      .map((tab) => getHost(tab.url))
      .filter((host) => host)
  );

  const aggregated = new Map();

  historyItems.forEach((item) => {
    const host = getHost(item.url);
    if (!host) {
      return;
    }

    const existing = aggregated.get(host) || {
      host,
      visitCount: 0,
      lastVisitTime: 0
    };

    existing.visitCount += item.visitCount || 1;
    existing.lastVisitTime = Math.max(existing.lastVisitTime, item.lastVisitTime || 0);
    aggregated.set(host, existing);
  });

  const hosts = Array.from(aggregated.values()).map((entry) => {
    const isOpen = openHosts.has(entry.host);
    const score = entry.visitCount + (isOpen ? 10 : 0);
    return {
      ...entry,
      isOpen,
      score
    };
  });

  hosts.sort((a, b) => b.score - a.score);

  const maxScore = hosts[0]?.score || 1;
  const normalized = hosts.slice(0, 6).map((entry) => ({
    host: entry.host,
    visitCount: entry.visitCount,
    lastVisitTime: entry.lastVisitTime,
    isOpen: entry.isOpen,
    score: Math.max(0.2, entry.score / maxScore)
  }));

  return { ok: true, hosts: normalized };
}

async function captureWorkspace() {
  const windows = await chrome.windows.getAll({ populate: true });
  const payload = windows.map((win) => ({
    bounds: {
      left: win.left ?? 0,
      top: win.top ?? 0,
      width: win.width ?? 0,
      height: win.height ?? 0,
      state: win.state || "normal"
    },
    focused: Boolean(win.focused),
    tabs: (win.tabs || []).map((tab) => ({
      index: tab.index,
      url: tab.url || "",
      title: tab.title || "",
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
      groupId: tab.groupId ?? null
    })),
    tabGroups: []
  }));

  return { ok: true, windows: payload };
}

async function captureScreenshots() {
  const viewport = await captureViewport();
  if (!viewport.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    viewport: {
      contentType: viewport.contentType,
      dataUrl: viewport.dataUrl
    },
    fullPage: {
      contentType: "image/jpeg",
      dataUrl: null
    }
  };
}

async function captureViewport() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) {
    return { ok: false };
  }

  const dataUrl = await enqueueCapture(() =>
    chrome.tabs.captureVisibleTab(activeTab.windowId, {
      format: "jpeg",
      quality: 80
    })
  );

  return { ok: true, contentType: "image/jpeg", dataUrl };
}

async function ensureCaptureBudget() {
  const now = Date.now();
  const waitMs = Math.max(0, MIN_CAPTURE_INTERVAL_MS - (now - lastCaptureTime));
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastCaptureTime = Date.now();
}

function enqueueCapture(task) {
  const run = async () => {
    await ensureCaptureBudget();
    return task();
  };

  const next = captureQueue.then(run, run);
  captureQueue = next.catch(() => {});
  return next;
}

async function analyzeWorkflowSites(taskDescription) {
  if (!taskDescription || taskDescription.trim().length < 5) {
    return { ok: false, error: "Task description is required." };
  }

  const bundle = await buildWorkflowAnalysisBundle(taskDescription);
  const proxyResult = await callWorkflowSitesProxy({
    taskDescription: bundle.taskDescription,
    activeTab: bundle.activeTab,
    historyHosts: bundle.historyHosts,
    openTabHosts: bundle.openTabHosts,
    pageSignals: bundle.pageSignals
  });

  await chrome.storage.local.set({
    lastWorkflowAnalysis: {
      createdAt: new Date().toISOString(),
      bundle,
      proxyResult
    }
  });

  return { ok: true, bundle, proxyResult };
}

async function analyzeWorkflowSteps(taskDescription, workflowHosts = []) {
  if (!taskDescription || taskDescription.trim().length < 5) {
    return { ok: false, error: "Task description is required." };
  }

  const bundle = await buildWorkflowStepsBundle(taskDescription, workflowHosts);
  const proxyResult = await callWorkflowStepsProxy({
    taskDescription: bundle.taskDescription,
    activeTab: bundle.activeTab,
    openTabs: bundle.openTabs,
    historyItems: bundle.historyItems,
    workflowHosts: bundle.workflowHosts
  });

  await chrome.storage.local.set({
    lastWorkflowSteps: {
      createdAt: new Date().toISOString(),
      bundle,
      proxyResult
    }
  });

  return { ok: true, bundle, proxyResult };
}

async function buildWorkflowAnalysisBundle(taskDescription) {
  const sinceMs = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const [activeTab, openTabs] = await Promise.all([
    getActiveTab(),
    getOpenTabsCurrentWindow()
  ]);

  const openTabHosts = buildOpenTabHosts(openTabs);
  const openTabHostSet = new Set(openTabHosts.map((host) => host.host));
  const historyItems = await getHistoryItems({ sinceMs, maxResults: MAX_HISTORY_ITEMS });
  const historyHosts = summarizeHistoryByHost(historyItems, openTabHostSet);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const pageSignals = tab?.id ? await getPageSignalsFromTab(tab.id) : {};

  return {
    taskDescription,
    activeTab,
    historyHosts,
    openTabHosts,
    pageSignals
  };
}

async function buildWorkflowStepsBundle(taskDescription, workflowHosts) {
  const sinceMs = Date.now() - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const [activeTab, openTabs] = await Promise.all([
    getActiveTab(),
    getOpenTabsCurrentWindow()
  ]);

  const historyItems = await getHistoryItemsDetailed({
    sinceMs,
    maxResults: MAX_STEP_HISTORY_ITEMS
  });

  return {
    taskDescription,
    activeTab,
    openTabs,
    historyItems,
    workflowHosts: Array.isArray(workflowHosts) ? workflowHosts : []
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) {
    throw new Error("No active tab found");
  }
  return { url: tab.url, title: tab.title || "" };
}

async function getOpenTabsCurrentWindow() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  return tabs
    .filter((tab) => typeof tab.url === "string")
    .map((tab) => ({ url: tab.url, title: tab.title || "" }));
}

function buildOpenTabHosts(openTabs) {
  const map = new Map();
  openTabs.forEach((tab) => {
    const host = safeUrlToHost(tab.url);
    if (!host) {
      return;
    }
    if (!map.has(host)) {
      map.set(host, { host, sampleUrls: [] });
    }
    map.get(host).sampleUrls.push(tab.url);
  });
  return Array.from(map.values()).map((entry) => ({
    host: entry.host,
    sampleUrls: uniq(entry.sampleUrls).slice(0, MAX_SAMPLE_URLS_PER_HOST)
  }));
}

async function getHistoryItems({ sinceMs, maxResults }) {
  const items = await chrome.history.search({
    text: "",
    startTime: sinceMs,
    maxResults
  });
  return items.filter((item) => typeof item.url === "string" && safeUrlToHost(item.url));
}

async function getHistoryItemsDetailed({ sinceMs, maxResults }) {
  const items = await chrome.history.search({
    text: "",
    startTime: sinceMs,
    maxResults
  });

  return items
    .filter((item) => typeof item.url === "string" && safeUrlToHost(item.url))
    .map((item) => ({
      url: item.url,
      title: item.title || "",
      lastVisitTime: item.lastVisitTime || 0,
      visitCount: item.visitCount || 0
    }))
    .sort((a, b) => b.lastVisitTime - a.lastVisitTime);
}

function summarizeHistoryByHost(historyItems, openTabHostSet) {
  const hostMap = new Map();

  historyItems.forEach((item) => {
    const host = safeUrlToHost(item.url);
    if (!host) {
      return;
    }
    if (!hostMap.has(host)) {
      hostMap.set(host, {
        host,
        visitCount: 0,
        lastVisitTime: 0,
        sampleUrls: [],
        openTab: openTabHostSet.has(host)
      });
    }

    const entry = hostMap.get(host);
    entry.visitCount += item.visitCount || 1;
    entry.lastVisitTime = Math.max(entry.lastVisitTime, item.lastVisitTime || 0);
    if (entry.sampleUrls.length < MAX_SAMPLE_URLS_PER_HOST * 3) {
      entry.sampleUrls.push(item.url);
    }
  });

  hostMap.forEach((entry) => {
    entry.sampleUrls = uniq(entry.sampleUrls).slice(0, MAX_SAMPLE_URLS_PER_HOST);
  });

  const ranked = sortHostsByScore(hostMap);
  return ranked.slice(0, MAX_HOSTS).map(({ _score, ...rest }) => rest);
}

function sortHostsByScore(hostMap) {
  const now = Date.now();
  const hour = 60 * 60 * 1000;

  return Array.from(hostMap.values())
    .map((entry) => {
      const hoursAgo = Math.max(0, (now - entry.lastVisitTime) / hour);
      const recencyBoost = 1 / (1 + hoursAgo / 24);
      const openBoost = entry.openTab ? 0.25 : 0;
      const score = entry.visitCount + recencyBoost + openBoost;
      return { ...entry, _score: score };
    })
    .sort((a, b) => b._score - a._score);
}

async function callWorkflowSitesProxy(payload) {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${PROXY_BASE_URL}/api/context/workflow-sites`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error || `Proxy error (${response.status})`;
    const details = json?.schemaErrors ? JSON.stringify(json.schemaErrors) : "";
    throw new Error(`${msg}${details ? `: ${details}` : ""}`);
  }
  return json;
}

async function callWorkflowStepsProxy(payload) {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${PROXY_BASE_URL}/api/context/workflow-steps`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId
    },
    body: JSON.stringify(payload)
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error || `Proxy error (${response.status})`;
    const details = json?.schemaErrors ? JSON.stringify(json.schemaErrors) : "";
    throw new Error(`${msg}${details ? `: ${details}` : ""}`);
  }
  return json;
}

async function getPageSignalsFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_SIGNALS" });
    return response?.pageSignals || {};
  } catch (error) {
    return {};
  }
}

function getHost(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.host;
    }
  } catch (error) {
    return null;
  }
  return null;
}

function safeUrlToHost(url) {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.host;
    }
  } catch (error) {
    return null;
  }
  return null;
}

function uniq(values) {
  return Array.from(new Set(values));
}

function isInjectableUrl(url) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (error) {
    return false;
  }
}
