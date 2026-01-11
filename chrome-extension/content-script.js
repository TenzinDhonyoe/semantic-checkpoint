if (!globalThis.__tdrInjected) {
  globalThis.__tdrInjected = true;

  const OVERLAY_ID = "mental-deloadr-overlay";
  const OVERLAY_STYLE_ID = "mental-deloadr-style";

const DEFAULT_HOSTS = [
  {
    host: "looker.yourcorp.com",
    badge: "Frequent",
    status: "open",
    includeInTask: true,
    captureSession: true
  },
  {
    host: "reports.yourcorp.com",
    badge: "Open Now",
    status: "open",
    includeInTask: true,
    captureSession: true
  },
  {
    host: "slack.com",
    badge: "",
    status: "idle",
    includeInTask: false,
    captureSession: false
  }
];

let overlayRoot = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initPolling());
} else {
  initPolling();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "toggle-overlay") {
    toggleOverlay();
  }

  if (message?.type === "GET_PAGE_SIGNALS") {
    const selectedText = window.getSelection()?.toString()?.trim() || "";
    sendResponse({
      pageSignals: {
        selectedText: selectedText.slice(0, 5000),
        visibleHeadings: getVisibleHeadings(25)
      }
    });
    return true;
  }

  return false;
});

function initPolling() {
  chrome.runtime.sendMessage({ type: "poll-blocked" });
}

function toggleOverlay() {
  if (overlayRoot) {
    overlayRoot.remove();
    overlayRoot = null;
    return;
  }
  overlayRoot = createOverlay();
  document.documentElement.appendChild(overlayRoot);
}

function createOverlay() {
  const host = document.createElement("div");
  host.id = OVERLAY_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.id = OVERLAY_STYLE_ID;
  style.textContent = overlayStyles;

  const container = document.createElement("div");
  container.className = "tdr-root";
  container.innerHTML = overlayTemplate;

  shadow.append(style, container);
  initOverlayUI(container, shadow);

  return host;
}

function initOverlayUI(container, shadow) {
  const selectedText = window.getSelection()?.toString().trim();
  const state = {
    step: 1,
    taskDescription: "",
    taskTitle: "Weekly Engagement Report",
    captureSelection: Boolean(selectedText),
    hosts: DEFAULT_HOSTS.map((host) => ({ ...host, isEditing: false })),
    workflowSteps: {
      steps: [],
      markdown: "",
      status: "idle",
      error: "",
      sources: []
    },
    stepsConfirmed: false
  };

  const stepButtons = {
    next: shadow.querySelector("[data-action='next']"),
    back: shadow.querySelector("[data-action='back']"),
    cancel: shadow.querySelector("[data-action='cancel']"),
    save: shadow.querySelector("[data-action='save']")
  };

  const taskTextarea = shadow.querySelector("#task-description");
  const selectionToggle = shadow.querySelector("#capture-selection");
  const titleInput = shadow.querySelector("#task-title");

  taskTextarea.value = state.taskDescription;
  titleInput.value = state.taskTitle;
  selectionToggle.checked = state.captureSelection;

  taskTextarea.addEventListener("input", (event) => {
    state.taskDescription = event.target.value;
  });

  titleInput.addEventListener("input", (event) => {
    state.taskTitle = event.target.value;
    updateSummary(state, shadow);
  });

  selectionToggle.addEventListener("change", (event) => {
    state.captureSelection = event.target.checked;
  });

  stepButtons.next.addEventListener("click", () => {
    if (state.step < 3) {
      state.step += 1;
      updateStep(state, shadow);
    }
  });

  stepButtons.back.addEventListener("click", () => {
    if (state.step > 1) {
      state.step -= 1;
      updateStep(state, shadow);
    }
  });

  stepButtons.cancel.addEventListener("click", () => {
    const host = shadow.host;
    host.remove();
    overlayRoot = null;
  });

  stepButtons.save.addEventListener("click", async () => {
    if (state.workflowSteps.steps.length && !state.stepsConfirmed) {
      if (stepsStatus) {
        stepsStatus.textContent = "Confirm the steps before saving.";
        setTimeout(() => {
          stepsStatus.textContent = "";
        }, 2000);
      }
      return;
    }
    stepButtons.save.disabled = true;
    stepButtons.save.textContent = "Saving...";
    const workspace = await chrome.runtime.sendMessage({ type: "capture-workspace" });
    const viewport = await chrome.runtime.sendMessage({ type: "capture-viewport" });
    const fullPage = await captureFullPageScreenshot();
    await chrome.runtime.sendMessage({
      type: "submit-workflow-steps",
      payload: buildWorkflowSubmissionPayload(state)
    });
    await chrome.runtime.sendMessage({
      type: "submit-task",
      payload: buildStubPayload(state, workspace, viewport, fullPage)
    });
    stepButtons.save.textContent = "Saved";
  });

  const analyzeButton = shadow.querySelector("[data-action='analyze-workflow']");
  const workflowStatus = shadow.querySelector("#workflow-status");
  const revokeButton = shadow.querySelector("[data-action='revoke-auth']");
  const stepsButton = shadow.querySelector("[data-action='generate-steps']");
  const stepsStatus = shadow.querySelector("#steps-status");
  const stepsConfirm = shadow.querySelector("#confirm-steps");

  analyzeButton.addEventListener("click", async () => {
    analyzeButton.disabled = true;
    workflowStatus.textContent = "Analyzing history...";
    try {
      await requestWorkflowAnalysis(state, shadow);
      workflowStatus.textContent = "Suggestions updated.";
    } catch (error) {
      const message = error?.message || "Analysis failed.";
      if (message.toLowerCase().includes("proxy")) {
        workflowStatus.textContent = "Proxy offline. Showing local suggestions.";
        await loadLocalSuggestions(state, shadow);
      } else {
        workflowStatus.textContent = message;
      }
    } finally {
      analyzeButton.disabled = false;
      setTimeout(() => {
        workflowStatus.textContent = "";
      }, 2000);
    }
  });

  revokeButton.addEventListener("click", async () => {
    revokeButton.disabled = true;
    revokeButton.textContent = "Revoking...";
    await chrome.runtime.sendMessage({ type: "revoke-auth" });
    revokeButton.textContent = "Revoked";
  });

  stepsButton.addEventListener("click", async () => {
    stepsButton.disabled = true;
    stepsStatus.textContent = "Generating steps...";
    state.workflowSteps.status = "loading";
    state.workflowSteps.error = "";
    state.stepsConfirmed = false;
    if (stepsConfirm) {
      stepsConfirm.checked = false;
    }
    renderWorkflowSteps(state, shadow);

    try {
      await requestWorkflowSteps(state, shadow);
      stepsStatus.textContent = "Steps ready for review.";
    } catch (error) {
      const message = error?.message || "Step generation failed.";
      stepsStatus.textContent = message;
      state.workflowSteps.error = message;
    } finally {
      state.workflowSteps.status = "idle";
      stepsButton.disabled = false;
      setTimeout(() => {
        stepsStatus.textContent = "";
      }, 2500);
      renderWorkflowSteps(state, shadow);
    }
  });

  if (stepsConfirm) {
    stepsConfirm.addEventListener("change", (event) => {
      state.stepsConfirmed = event.target.checked;
      updateSaveState(state, shadow);
    });
  }

  renderHosts(state, shadow);
  updateStep(state, shadow);
  loadDiscoveredHosts(state, shadow);
  renderWorkflowSteps(state, shadow);
}

function renderHosts(state, shadow) {
  const list = shadow.querySelector("#workflow-hosts");
  list.innerHTML = "";

  state.hosts.forEach((host, index) => {
    const card = document.createElement("div");
    card.className = "tdr-card tdr-host-card";

    const badge = host.badge ? `<span class="tdr-pill">${host.badge}</span>` : "";
    const reason = host.reason ? `<div class="tdr-host-reason">${host.reason}</div>` : "";
    const score = typeof host.score === "number"
      ? `<span class="tdr-pill tdr-pill-muted">${Math.round(host.score * 100)}%</span>`
      : "";
    const hostTitle = host.isEditing
      ? `<input class="tdr-input tdr-host-edit" data-edit=\"host\" data-index=\"${index}\" value=\"${host.host}\" />`
      : `<div class=\"tdr-host-title\">${host.host}</div>`;
    const actions = host.isEditing
      ? `<div class=\"tdr-host-actions\">
          <button class=\"tdr-button tdr-button-ghost\" data-action=\"save-host\" data-index=\"${index}\">Save</button>
          <button class=\"tdr-button tdr-button-ghost\" data-action=\"cancel-host\" data-index=\"${index}\">Cancel</button>
        </div>`
      : `<div class=\"tdr-host-actions\">
          <button class=\"tdr-button tdr-button-ghost\" data-action=\"edit-host\" data-index=\"${index}\">Edit</button>
          <button class=\"tdr-button tdr-button-ghost\" data-action=\"remove-host\" data-index=\"${index}\">Remove</button>
        </div>`;

    card.innerHTML = `
      <div class="tdr-host-row">
        <div class="tdr-host-meta">
          <div class="tdr-host-icon" aria-hidden="true">${host.status === "open" ? "🧭" : "💬"}</div>
          <div>
            ${hostTitle}
            <div class="tdr-host-meta-row">${badge}${score}</div>
            ${reason}
          </div>
        </div>
        ${actions}
      </div>
      <div class="tdr-toggle-row">
        <label class="tdr-toggle">
          <input type="checkbox" ${host.includeInTask ? "checked" : ""} data-toggle="include" data-index="${index}" />
          <span class="tdr-toggle-ui"></span>
          <span>Include in Task</span>
        </label>
        <label class="tdr-toggle">
          <input type="checkbox" ${host.captureSession ? "checked" : ""} data-toggle="session" data-index="${index}" />
          <span class="tdr-toggle-ui"></span>
          <span>Capture Session (Encrypted)</span>
        </label>
      </div>
    `;

    list.appendChild(card);
  });

  list.querySelectorAll("input[data-toggle]").forEach((input) => {
    input.addEventListener("change", (event) => {
      const idx = Number(event.target.dataset.index);
      const toggleType = event.target.dataset.toggle;
      if (toggleType === "include") {
        const isIncluded = event.target.checked;
        state.hosts[idx].includeInTask = isIncluded;
        if (!isIncluded && state.hosts[idx].captureSession) {
          state.hosts[idx].captureSession = false;
          renderHosts(state, shadow);
          return;
        }
      }
      if (toggleType === "session") {
        state.hosts[idx].captureSession = event.target.checked;
      }
      updateSummary(state, shadow);
    });
  });

  list.querySelectorAll("[data-action='edit-host']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const idx = Number(event.target.dataset.index);
      state.hosts[idx].isEditing = true;
      renderHosts(state, shadow);
    });
  });

  list.querySelectorAll("[data-action='remove-host']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const idx = Number(event.target.dataset.index);
      state.hosts.splice(idx, 1);
      renderHosts(state, shadow);
    });
  });

  list.querySelectorAll("[data-action='save-host']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const idx = Number(event.target.dataset.index);
      const input = list.querySelector(`input[data-edit='host'][data-index='${idx}']`);
      if (input?.value?.trim()) {
        state.hosts[idx].host = input.value.trim();
      }
      state.hosts[idx].isEditing = false;
      renderHosts(state, shadow);
    });
  });

  list.querySelectorAll("[data-action='cancel-host']").forEach((button) => {
    button.addEventListener("click", (event) => {
      const idx = Number(event.target.dataset.index);
      state.hosts[idx].isEditing = false;
      renderHosts(state, shadow);
    });
  });

  updateSummary(state, shadow);
}

function updateSummary(state, shadow) {
  const tabsCount = shadow.querySelector("#summary-tabs");
  const authCount = shadow.querySelector("#summary-auth");
  const stepsCount = shadow.querySelector("#summary-steps");

  const includedHosts = state.hosts.filter((host) => host.includeInTask);
  const authHosts = state.hosts.filter((host) => host.captureSession);

  tabsCount.textContent = `${includedHosts.length} Tabs (${includedHosts.map((host) => host.host.split(".")[0]).join(", ") || "-"})`;
  authCount.textContent = `${authHosts.length} Encrypted Auth Sessions`;
  if (stepsCount) {
    const stepsTotal = state.workflowSteps.steps.length;
    stepsCount.textContent = `${stepsTotal} Generated Steps`;
  }
}

function updateStep(state, shadow) {
  const root = shadow.querySelector(".tdr-root");
  root.dataset.step = String(state.step);

  const stepLabels = shadow.querySelectorAll(".tdr-step");
  stepLabels.forEach((stepLabel, index) => {
    const stepNumber = index + 1;
    stepLabel.classList.toggle("is-active", stepNumber === state.step);
    stepLabel.classList.toggle("is-complete", stepNumber < state.step);
  });

  const backButton = shadow.querySelector("[data-action='back']");
  const nextButton = shadow.querySelector("[data-action='next']");
  const saveButton = shadow.querySelector("[data-action='save']");

  backButton.disabled = state.step === 1;
  nextButton.classList.toggle("is-hidden", state.step === 3);
  saveButton.classList.toggle("is-hidden", state.step !== 3);
  updateSaveState(state, shadow);
}

function updateSaveState(state, shadow) {
  const saveButton = shadow.querySelector("[data-action='save']");
  if (!saveButton) {
    return;
  }
  if (state.step !== 3) {
    saveButton.disabled = false;
    return;
  }
  const needsConfirmation = state.workflowSteps.steps.length > 0;
  saveButton.disabled = needsConfirmation && !state.stepsConfirmed;
}

function buildStubPayload(state, workspace, viewport, fullPage) {
  const viewportScreenshot = viewport?.ok ? viewport : null;
  const fullPageScreenshot = fullPage?.ok ? fullPage : null;
  return {
    version: "v1",
    client: {
      type: "chrome-extension",
      extensionVersion: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      capturedAt: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    },
    task: {
      title: state.taskTitle,
      userPrompt: state.taskDescription,
      source: {
        activeTab: {
          url: window.location.href,
          title: document.title
        }
      },
      taskSpec: {
        goal: "",
        deliverables: [],
        steps: state.workflowSteps.steps.map((step) => ({
          text: step.text,
          sourceUrl: step.sourceUrl,
          sourceTitle: step.sourceTitle,
          requiresSession: Boolean(step.requiresSession)
        })),
        questions: []
      }
    },
    context: {
      workspace: { windows: workspace?.windows || [] },
      pageSnapshot: {
        primary: {
          url: window.location.href,
          title: document.title,
          screenshot: {
            contentType: viewportScreenshot?.contentType || "image/jpeg",
            ref: viewportScreenshot?.dataUrl || "pending"
          },
          fullPageScreenshot: {
            contentType: fullPageScreenshot?.contentType || "image/jpeg",
            ref: fullPageScreenshot?.dataUrl || "pending"
          },
          selectionText: state.captureSelection ? window.getSelection()?.toString() : ""
        }
      },
      workflowDiscovery: {
        candidates: state.hosts.map((host) => ({
          host: host.host,
          score: host.includeInTask ? 0.9 : 0.4,
          evidence: {
            manual: host.badge === "Manual"
          }
        })),
        confirmed: state.hosts.map((host) => ({
          host: host.host,
          includeAuth: host.captureSession
        }))
      },
      workflowSteps: {
        markdown: state.workflowSteps.markdown,
        steps: state.workflowSteps.steps
      },
      authSnapshot: {
        version: "cookies-v1",
        cookieStoreId: "default",
        bundles: []
      }
    }
  };
}

async function captureFullPageScreenshot() {
  const totalHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight || 0
  );
  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;
  const dpr = window.devicePixelRatio || 1;

  if (!totalHeight || !viewportHeight || !viewportWidth) {
    return { ok: false };
  }

  // Cap height to stay within common canvas limits.
  const maxCanvasHeight = 16384;
  const targetHeight = Math.min(totalHeight, maxCanvasHeight);

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewportWidth * dpr);
  canvas.height = Math.floor(targetHeight * dpr);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return { ok: false };
  }

  const originalScrollY = window.scrollY;
  let offsetY = 0;

  try {
    while (offsetY < targetHeight) {
      window.scrollTo(0, offsetY);
      await waitForFrame(450);
      const capture = await chrome.runtime.sendMessage({ type: "capture-viewport" });
      if (!capture?.ok || !capture.dataUrl) {
        break;
      }

      const img = await loadImage(capture.dataUrl);
      const drawHeight = Math.min(viewportHeight, targetHeight - offsetY);
      ctx.drawImage(
        img,
        0,
        0,
        img.width,
        img.height,
        0,
        Math.floor(offsetY * dpr),
        canvas.width,
        Math.floor(drawHeight * dpr)
      );

      offsetY += viewportHeight;
    }
  } finally {
    window.scrollTo(0, originalScrollY);
  }

  const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
  return { ok: true, contentType: "image/jpeg", dataUrl };
}

function waitForFrame(delayMs) {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, delayMs);
    });
  });
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function loadDiscoveredHosts(state, shadow) {
  try {
    await requestWorkflowAnalysis(state, shadow);
    return;
  } catch (error) {
    // Fall back to local history-only suggestions when proxy is offline.
    await loadLocalSuggestions(state, shadow);
  }
}

async function loadLocalSuggestions(state, shadow) {
  const response = await chrome.runtime.sendMessage({ type: "discover-hosts" });
  if (!response?.ok || !Array.isArray(response.hosts) || response.hosts.length === 0) {
    return;
  }

  state.hosts = response.hosts.map((host) => ({
    host: host.host,
    badge: deriveBadge(host),
    status: host.isOpen ? "open" : "idle",
    includeInTask: host.isOpen,
    captureSession: host.isOpen,
    isEditing: false,
    visitCount: host.visitCount,
    lastVisitTime: host.lastVisitTime,
    isOpen: host.isOpen
  }));
  renderHosts(state, shadow);
}

async function requestWorkflowAnalysis(state, shadow) {
  const taskDescription = state.taskDescription.trim();
  if (!taskDescription) {
    throw new Error("Task description required");
  }

  const response = await chrome.runtime.sendMessage({
    type: "ANALYZE_WORKFLOW_SITES",
    taskDescription
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Workflow analysis failed");
  }

  const workflowHosts = response?.proxyResult?.workflow?.workflowHosts || [];
  if (!workflowHosts.length) {
    throw new Error("No workflow suggestions");
  }

  state.hosts = workflowHosts.map((host) => ({
    host: host.host,
    badge: "Suggested",
    status: host.authLikelyRequired ? "open" : "idle",
    includeInTask: true,
    captureSession: Boolean(host.authLikelyRequired),
    isEditing: false,
    score: host.score,
    reason: host.why,
    suggestedUrls: host.suggestedUrls || []
  }));

  renderHosts(state, shadow);
}

async function requestWorkflowSteps(state, shadow) {
  const taskDescription = state.taskDescription.trim();
  if (!taskDescription) {
    throw new Error("Task description required");
  }

  const workflowHosts = state.hosts.map((host) => ({
    host: host.host,
    includeInTask: Boolean(host.includeInTask),
    includeAuth: Boolean(host.captureSession)
  }));

  const response = await chrome.runtime.sendMessage({
    type: "ANALYZE_WORKFLOW_STEPS",
    taskDescription,
    workflowHosts
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Workflow step generation failed");
  }

  const workflowSteps = response?.proxyResult?.workflow || {};
  const steps = Array.isArray(workflowSteps.steps) ? workflowSteps.steps : [];

  state.workflowSteps.steps = steps;
  const workflowPayload = buildWorkflowPayload({
    taskTitle: state.taskTitle,
    taskDescription,
    steps
  });
  state.workflowSteps.markdown = workflowPayload.workflow_md;
  state.workflowSteps.sources = workflowPayload.sources;
  state.stepsConfirmed = false;
  const stepsConfirm = shadow.querySelector("#confirm-steps");
  if (stepsConfirm) {
    stepsConfirm.checked = false;
  }
  updateSummary(state, shadow);
}

function renderWorkflowSteps(state, shadow) {
  const container = shadow.querySelector("#workflow-steps");
  if (!container) {
    return;
  }

  if (state.workflowSteps.status === "loading") {
    container.textContent = "Generating steps from your recent history...";
    updateSaveState(state, shadow);
    return;
  }

  if (state.workflowSteps.error) {
    container.textContent = `Error: ${state.workflowSteps.error}`;
    updateSaveState(state, shadow);
    return;
  }

  if (!state.workflowSteps.steps.length) {
    container.textContent = "No steps yet. Generate steps to review them before saving.";
    updateSaveState(state, shadow);
    return;
  }

  container.textContent = state.workflowSteps.markdown || buildFallbackMarkdown(state.taskDescription, state.workflowSteps.steps);
  updateSaveState(state, shadow);
}

function buildFallbackMarkdown(taskDescription, steps) {
  const lines = ["# Task Steps", ""];
  if (taskDescription) {
    lines.push(`Task: ${taskDescription}`, "");
  }
  steps.forEach((step, index) => {
    const requiresSession = step.requiresSession ? "Yes" : "No";
    lines.push(`${index + 1}. ${step.text}`);
    lines.push(`   - Source: ${step.sourceUrl}`);
    lines.push(`   - Requires session: ${requiresSession}`);
    if (step.sourceTitle) {
      lines.push(`   - Source title: ${step.sourceTitle}`);
    }
    lines.push("");
  });
  return lines.join("\n").trim();
}

function buildWorkflowSubmissionPayload(state) {
  const workflowPayload = buildWorkflowPayload({
    taskTitle: state.taskTitle,
    taskDescription: state.taskDescription,
    steps: state.workflowSteps.steps
  });

  return {
    ...workflowPayload,
    client: {
      type: "chrome-extension",
      extensionVersion: chrome.runtime.getManifest().version,
      capturedAt: new Date().toISOString()
    }
  };
}

function buildWorkflowPayload({ taskTitle, taskDescription, steps }) {
  const title = taskTitle?.trim() || "Untitled Workflow";
  const description = taskDescription?.trim() || "Captured workflow description";
  const deliverable = "Markdown workflow instructions";

  const sources = [];
  const sourceIndexByUrl = new Map();
  const markdownLines = [];

  steps.forEach((step, index) => {
    const titleText = deriveStepTitle(step.text, index);
    const stepId = slugifyStepId(titleText, index);
    const sourceUrl = step.sourceUrl || "";
    let sourceKey = sourceIndexByUrl.get(sourceUrl);
    if (!sourceKey) {
      sourceKey = buildSourceKey(sourceUrl, sources.length + 1);
      sourceIndexByUrl.set(sourceUrl, sourceKey);
      sources.push({
        key: sourceKey,
        type: "page",
        mode: "snapshot",
        snapshot: {
          url: sourceUrl,
          title: step.sourceTitle || titleText,
          captured_at: new Date().toISOString()
        }
      });
    }
    const requiresSession = Boolean(step.requiresSession);

    markdownLines.push(`## Step ${index + 1}: ${titleText} (id: ${stepId})`);
    markdownLines.push(`${step.text} [[source:${sourceKey}]]${requiresSession ? " [[requires:session]]" : ""}`);
    markdownLines.push("");
  });

  return {
    title,
    description,
    deliverable,
    workflow_md: markdownLines.join("\n").trim(),
    sources
  };
}

function deriveStepTitle(text, index) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return `Step ${index + 1}`;
  }
  const maxLength = 60;
  const short = trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
  return short.replace(/[.]+$/, "");
}

function slugifyStepId(text, index) {
  const base = (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!base) {
    return `step_${index + 1}`;
  }
  return base.slice(0, 40);
}

function buildSourceKey(sourceUrl, index) {
  try {
    const host = new URL(sourceUrl).host;
    const sanitized = host.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase();
    return `page_${sanitized}_${index + 1}`;
  } catch (error) {
    return `page_unknown_${index + 1}`;
  }
}

function deriveBadge(host) {
  if (host.isOpen) {
    return "Open Now";
  }
  if (host.visitCount >= 8) {
    return "Frequent";
  }
  const oneHour = 60 * 60 * 1000;
  if (host.lastVisitTime && Date.now() - host.lastVisitTime < oneHour) {
    return "Recent";
  }
  return "";
}

function getVisibleHeadings(max) {
  const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
    .map((el) => el.innerText?.trim())
    .filter(Boolean);
  return headings.slice(0, max);
}

const overlayTemplate = `
  <div class="tdr-overlay">
    <div class="tdr-sidebar">
      <header class="tdr-header">
        <div>
          <div class="tdr-title">New Task Capture</div>
        </div>
        <button class="tdr-icon-button" data-action="cancel" aria-label="Close">×</button>
      </header>

      <div class="tdr-stepper">
        <div class="tdr-step is-active">
          <span>1. Describe</span>
        </div>
        <div class="tdr-step">
          <span>2. Identify Workflow</span>
        </div>
        <div class="tdr-step">
          <span>3. Confirm</span>
        </div>
      </div>

      <section class="tdr-panel" data-panel="1">
        <label class="tdr-label">What are you working on?</label>
        <textarea id="task-description" class="tdr-textarea" rows="6" placeholder="Describe what you've been working on so we can automate that and offload it for you."></textarea>

        <div class="tdr-card tdr-context-card">
          <div class="tdr-label">Active Tab Context</div>
          <div class="tdr-context-row">
            <span class="tdr-context-icon">🧭</span>
            <span class="tdr-context-text">${document.title}</span>
          </div>
        </div>

        <label class="tdr-toggle tdr-selection-toggle">
          <input id="capture-selection" type="checkbox" />
          <span class="tdr-toggle-ui"></span>
          <span>Capture selected text on page</span>
        </label>
      </section>

      <section class="tdr-panel" data-panel="2">
        <div class="tdr-panel-header">
          <div class="tdr-label">Discovered workflow hosts</div>
          <div class="tdr-analysis-row">
            <button class="tdr-button tdr-button-secondary" data-action="analyze-workflow">Suggest workflow sites</button>
            <span class="tdr-analysis-status" id="workflow-status"></span>
          </div>
        </div>
        <div id="workflow-hosts" class="tdr-host-list"></div>

        <div class="tdr-card tdr-privacy-card">
          <div class="tdr-privacy-row">
            <span class="tdr-privacy-icon">🛡️</span>
            <div>
              <div class="tdr-privacy-title">Privacy Summary</div>
              <div class="tdr-privacy-text">2 Tabs, 2 Auth Sessions (Encrypted), 1 Screenshot.</div>
            </div>
          </div>
        </div>
      </section>

      <section class="tdr-panel" data-panel="3">
        <div class="tdr-label">Confirm Task Details</div>
        <label class="tdr-label tdr-label-muted" for="task-title">Task Title</label>
        <input id="task-title" class="tdr-input" type="text" />

        <div class="tdr-summary">
          <div class="tdr-label">Summary</div>
          <div class="tdr-summary-row" id="summary-tabs">2 Tabs (Looker, Reports)</div>
          <div class="tdr-summary-row" id="summary-auth">2 Encrypted Auth Sessions</div>
          <div class="tdr-summary-row" id="summary-steps">0 Generated Steps</div>
          <div class="tdr-summary-row">1 Viewport + 1 Full Page Screenshot</div>
        </div>

        <div class="tdr-card tdr-steps-card">
          <div class="tdr-panel-header">
            <div class="tdr-label">Draft step-by-step</div>
            <div class="tdr-analysis-row">
              <button class="tdr-button tdr-button-secondary" data-action="generate-steps">Generate steps</button>
              <span class="tdr-analysis-status" id="steps-status"></span>
            </div>
          </div>
          <pre id="workflow-steps" class="tdr-steps-preview"></pre>
          <label class="tdr-toggle tdr-steps-confirm">
            <input id="confirm-steps" type="checkbox" />
            <span class="tdr-toggle-ui"></span>
            <span>I confirm these steps look accurate.</span>
          </label>
        </div>

        <div class="tdr-card tdr-privacy-card">
          <div class="tdr-privacy-row">
            <span class="tdr-privacy-icon">🔒</span>
            <div>
              <div class="tdr-privacy-title">Privacy & Encryption</div>
              <div class="tdr-privacy-text">Your session data is encrypted client-side with your organization's key before upload. You can revoke access anytime.</div>
            </div>
          </div>
          <button class="tdr-button tdr-button-ghost tdr-revoke" data-action="revoke-auth">Revoke Auth Snapshots</button>
        </div>
      </section>

      <footer class="tdr-footer">
        <button class="tdr-button tdr-button-primary" data-action="next">Next</button>
        <button class="tdr-button tdr-button-secondary" data-action="save">Save Task</button>
        <button class="tdr-button tdr-button-secondary" data-action="back">Back</button>
        <button class="tdr-button tdr-button-ghost" data-action="cancel">Cancel</button>
      </footer>
    </div>
  </div>
`;

const overlayStyles = `
  :host {
    all: initial;
  }

  .tdr-root {
    --tdr-bg: #f4f6fb;
    --tdr-panel-bg: #ffffff;
    --tdr-border: #d7dce5;
    --tdr-muted: #6b7280;
    --tdr-text: #0f172a;
    --tdr-accent: #2b6cb0;
    --tdr-accent-dark: #1f4f85;
    --tdr-pill: #e3eefc;
    --tdr-shadow: 0 16px 36px rgba(15, 23, 42, 0.2);
    --tdr-radius-lg: 18px;
    --tdr-radius-md: 12px;
    --tdr-radius-sm: 8px;
    --tdr-gap: 16px;
    --tdr-font: "Trebuchet MS", "Segoe UI", sans-serif;

    color: var(--tdr-text);
    font-family: var(--tdr-font);
  }

  .tdr-overlay {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.45);
    backdrop-filter: blur(8px);
    display: flex;
    justify-content: flex-end;
    z-index: 2147483647;
    pointer-events: none;
  }

  .tdr-sidebar {
    width: 420px;
    height: 100vh;
    background: var(--tdr-bg);
    box-shadow: var(--tdr-shadow);
    display: flex;
    flex-direction: column;
    pointer-events: auto;
  }

  .tdr-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 20px 10px;
    border-bottom: 1px solid var(--tdr-border);
    background: var(--tdr-panel-bg);
  }

  .tdr-title {
    font-size: 18px;
    font-weight: 700;
  }

  .tdr-icon-button {
    border: none;
    background: transparent;
    font-size: 20px;
    cursor: pointer;
    color: var(--tdr-muted);
  }

  .tdr-stepper {
    display: flex;
    gap: 10px;
    padding: 12px 20px;
    font-size: 13px;
    color: var(--tdr-muted);
    border-bottom: 1px solid var(--tdr-border);
    background: linear-gradient(90deg, #f5f7fb, #eef2f7);
  }

  .tdr-step {
    position: relative;
    padding-bottom: 6px;
  }

  .tdr-step.is-active {
    color: var(--tdr-text);
    font-weight: 600;
  }

  .tdr-step.is-active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: var(--tdr-accent);
    border-radius: 999px;
  }

  .tdr-panel {
    display: none;
    padding: 18px 20px;
    overflow-y: auto;
    flex: 1;
    gap: var(--tdr-gap);
  }

  .tdr-root[data-step="1"] [data-panel="1"],
  .tdr-root[data-step="2"] [data-panel="2"],
  .tdr-root[data-step="3"] [data-panel="3"] {
    display: flex;
    flex-direction: column;
  }

  .tdr-label {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 6px;
  }

  .tdr-label-muted {
    color: var(--tdr-muted);
    font-weight: 500;
  }

  .tdr-textarea {
    width: 100%;
    padding: 12px;
    border: 2px solid var(--tdr-accent);
    border-radius: var(--tdr-radius-md);
    font-family: var(--tdr-font);
    font-size: 13px;
    resize: none;
    outline: none;
    background: #fefefe;
  }

  .tdr-input {
    width: 100%;
    padding: 10px 12px;
    border-radius: var(--tdr-radius-sm);
    border: 1px solid var(--tdr-border);
    font-family: var(--tdr-font);
    font-size: 13px;
    background: #fff;
  }

  .tdr-card {
    background: var(--tdr-panel-bg);
    border: 1px solid var(--tdr-border);
    border-radius: var(--tdr-radius-md);
    padding: 12px;
    box-shadow: 0 8px 16px rgba(15, 23, 42, 0.05);
  }

  .tdr-context-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .tdr-context-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
  }

  .tdr-context-icon {
    font-size: 18px;
  }

  .tdr-selection-toggle {
    margin-top: 6px;
  }

  .tdr-panel-header {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tdr-analysis-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .tdr-analysis-status {
    font-size: 12px;
    color: var(--tdr-muted);
  }

  .tdr-host-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .tdr-host-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .tdr-host-meta {
    display: flex;
    gap: 10px;
    align-items: center;
  }

  .tdr-host-icon {
    font-size: 20px;
  }

  .tdr-host-title {
    font-weight: 600;
  }

  .tdr-host-meta-row {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
  }

  .tdr-host-reason {
    font-size: 12px;
    color: var(--tdr-muted);
    margin-top: 4px;
  }

  .tdr-host-actions {
    display: flex;
    gap: 6px;
  }

  .tdr-host-edit {
    min-width: 160px;
  }

  .tdr-pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--tdr-pill);
    font-size: 11px;
    margin-top: 4px;
  }

  .tdr-pill-muted {
    background: #eef2f7;
    color: var(--tdr-muted);
  }

  .tdr-toggle-row {
    display: flex;
    gap: 14px;
    margin-top: 12px;
    flex-wrap: wrap;
  }

  .tdr-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--tdr-text);
  }

  .tdr-toggle input {
    display: none;
  }

  .tdr-toggle-ui {
    width: 34px;
    height: 18px;
    background: #d1d5db;
    border-radius: 999px;
    position: relative;
    transition: background 0.2s ease;
  }

  .tdr-toggle-ui::after {
    content: "";
    position: absolute;
    width: 14px;
    height: 14px;
    background: #fff;
    border-radius: 50%;
    top: 2px;
    left: 2px;
    transition: transform 0.2s ease;
  }

  .tdr-toggle input:checked + .tdr-toggle-ui {
    background: var(--tdr-accent);
  }

  .tdr-toggle input:checked + .tdr-toggle-ui::after {
    transform: translateX(16px);
  }

  .tdr-privacy-card {
    background: #f7fbff;
  }

  .tdr-privacy-row {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }

  .tdr-privacy-title {
    font-weight: 600;
    margin-bottom: 4px;
  }

  .tdr-privacy-text {
    font-size: 12px;
    color: var(--tdr-muted);
    line-height: 1.4;
  }

  .tdr-summary {
    margin-top: 10px;
    display: grid;
    gap: 6px;
  }

  .tdr-steps-card {
    margin-top: 12px;
  }

  .tdr-steps-preview {
    margin: 0;
    font-family: "Courier New", monospace;
    font-size: 12px;
    white-space: pre-wrap;
    background: #f8fafc;
    border-radius: var(--tdr-radius-sm);
    padding: 10px;
    color: var(--tdr-text);
    border: 1px dashed var(--tdr-border);
  }

  .tdr-steps-confirm {
    margin-top: 10px;
  }

  .tdr-summary-row {
    font-size: 13px;
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .tdr-revoke {
    margin-top: 12px;
    width: 100%;
  }

  .tdr-footer {
    display: flex;
    gap: 8px;
    padding: 16px 20px 20px;
    border-top: 1px solid var(--tdr-border);
    background: var(--tdr-panel-bg);
  }

  .tdr-button {
    border-radius: 12px;
    padding: 10px 16px;
    border: 1px solid transparent;
    font-family: var(--tdr-font);
    font-size: 13px;
    cursor: pointer;
  }

  .tdr-button-primary {
    background: linear-gradient(135deg, #2b6cb0, #3b82f6);
    color: #fff;
    flex: 1.5;
  }

  .tdr-button-secondary {
    background: #fff;
    border: 1px solid var(--tdr-border);
    color: var(--tdr-text);
    flex: 1;
  }

  .tdr-button-ghost {
    background: transparent;
    border: 1px solid var(--tdr-border);
    color: var(--tdr-muted);
  }

  .tdr-button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .tdr-button.is-hidden {
    display: none;
  }

  @media (max-width: 720px) {
    .tdr-sidebar {
      width: 100%;
    }

    .tdr-footer {
      flex-wrap: wrap;
    }
  }
`;
}
