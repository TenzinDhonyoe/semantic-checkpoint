import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

dotenv.config();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use(
  cors({
    origin: [
      /^chrome-extension:\/\//,
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8787"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id"]
  })
);

const FIREWORKS_BASE_URL = process.env.FIREWORKS_BASE_URL || "https://api.fireworks.ai/inference/v1";
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;
const FIREWORKS_MODEL = process.env.FIREWORKS_MODEL || "accounts/fireworks/models/llama-v3p1-70b-instruct";
const PORT = Number(process.env.PORT || 8787);

if (!FIREWORKS_API_KEY) {
  console.error("Missing FIREWORKS_API_KEY in .env");
  process.exit(1);
}

const workflowSchema = {
  $id: "WorkflowSites_v1",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["workflowHosts"],
  properties: {
    workflowHosts: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["host", "score", "why", "authLikelyRequired", "suggestedUrls"],
        properties: {
          host: { type: "string", minLength: 3, maxLength: 200 },
          score: { type: "number", minimum: 0, maximum: 1 },
          why: { type: "string", minLength: 3, maxLength: 400 },
          authLikelyRequired: { type: "boolean" },
          suggestedUrls: {
            type: "array",
            maxItems: 8,
            items: { type: "string", format: "uri" }
          }
        }
      }
    }
  }
};

const workflowStepsSchema = {
  $id: "WorkflowSteps_v1",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 25,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "sourceUrl", "requiresSession"],
        properties: {
          text: { type: "string", minLength: 3, maxLength: 400 },
          sourceUrl: { type: "string", format: "uri", minLength: 6, maxLength: 2000 },
          sourceTitle: { type: "string", minLength: 1, maxLength: 200 },
          requiresSession: { type: "boolean" }
        }
      }
    }
  }
};

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validateWorkflow = ajv.compile(workflowSchema);
const validateWorkflowSteps = ajv.compile(workflowStepsSchema);

function extractMessageTextFromResponsesApi(respJson) {
  if (typeof respJson?.output_text === "string") {
    return respJson.output_text.trim();
  }

  const out = respJson?.output;
  if (Array.isArray(out)) {
    const msg =
      out.find((item) => item?.type === "message" && item?.role === "assistant") ||
      out.find((item) => item?.type === "message") ||
      out[out.length - 1];
    const content = msg?.content;
    if (Array.isArray(content)) {
      return content
        .filter((block) => block?.type === "output_text" || block?.type === "text" || typeof block?.text === "string")
        .map((block) => block.text)
        .join("\n")
        .trim();
    }
  }

  if (Array.isArray(respJson?.choices)) {
    const choice = respJson.choices[0];
    if (typeof choice?.text === "string") {
      return choice.text.trim();
    }
    if (typeof choice?.message?.content === "string") {
      return choice.message.content.trim();
    }
  }

  return "";
}

async function fireworksResponses({ requestId, model, instructions, input, max_output_tokens = 1200, temperature = 0.2 }) {
  const url = `${FIREWORKS_BASE_URL}/responses`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens,
      temperature,
      store: false
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error?.message || json?.message || "Fireworks request failed";
    throw new Error(`[fireworks] ${response.status} ${msg}`);
  }

  return json;
}

async function fireworksChatCompletions({ requestId, model, messages, max_tokens = 1200, temperature = 0.2, response_format }) {
  const url = `${FIREWORKS_BASE_URL}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FIREWORKS_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens,
      temperature,
      response_format,
      stream: false
    })
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = json?.error?.message || json?.message || "Fireworks chat completion failed";
    throw new Error(`[fireworks-chat] ${response.status} ${msg}`);
  }

  return json;
}

function parseJsonLoose(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    return null;
  }
  const candidate = text.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeWorkflowPayload(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const payload = { ...obj };
  if (!payload.workflowHosts && Array.isArray(payload.hosts)) {
    payload.workflowHosts = payload.hosts;
    delete payload.hosts;
  }

  if (!Array.isArray(payload.workflowHosts)) {
    return payload;
  }

  payload.workflowHosts = payload.workflowHosts.map((host) => {
    const normalized = { ...host };
    if (!normalized.why && typeof normalized.reason === "string") {
      normalized.why = normalized.reason;
      delete normalized.reason;
    }
    if (!Array.isArray(normalized.suggestedUrls)) {
      normalized.suggestedUrls = [];
    }
    if (typeof normalized.score === "number") {
      normalized.score = Math.max(0, Math.min(1, normalized.score));
    }
    normalized.authLikelyRequired = Boolean(normalized.authLikelyRequired);
    return normalized;
  });

  return payload;
}

function buildSystemInstructions() {
  return [
    "You are a workflow discovery assistant for a browser extension.",
    "Return ONLY valid JSON with the exact schema: { \"workflowHosts\": [...] }.",
    "Do not include markdown, code fences, or extra text.",
    "Each workflowHost must include: host, score (0-1), why, authLikelyRequired, suggestedUrls.",
    "Base suggestions on the user's task description, open tabs, and browsing history hosts.",
    "Favor current tab and recently visited internal tools.",
    "Keep why concise and grounded in the evidence."
  ].join("\n");
}

function buildStepsSystemInstructions() {
  return [
    "You are a workflow summarization assistant for a browser extension.",
    "Return ONLY valid JSON with the exact schema: { \"steps\": [...] }.",
    "Do not include markdown, code fences, or extra text.",
    "Each step must include: text, sourceUrl, requiresSession.",
    "Use the browsing history to reconstruct a realistic step-by-step path.",
    "Mark requiresSession true for steps on authenticated apps or when workflowHosts indicate includeAuth."
  ].join("\n");
}

function buildUserPrompt(payload) {
  const { taskDescription, activeTab, historyHosts, openTabHosts, pageSignals } = payload;

  return [
    "Identify workflow hosts that are likely required for this task.",
    "",
    "Task description:",
    taskDescription,
    "",
    "Active tab:",
    JSON.stringify(activeTab, null, 2),
    "",
    "Open tab hosts:",
    JSON.stringify(openTabHosts, null, 2),
    "",
    "History hosts summary (last 7 days):",
    JSON.stringify(historyHosts, null, 2),
    "",
    "Page signals (optional):",
    JSON.stringify(pageSignals || {}, null, 2),
    "",
    "Rules:",
    "- Output 3-12 hosts when possible",
    "- score is confidence from 0 to 1",
    "- suggestedUrls should be sampled from open tabs or history",
    "- authLikelyRequired = true for typical SaaS apps",
    "- Use hostnames only (no paths)"
  ].join("\n");
}

function buildStepsUserPrompt(payload) {
  const { taskDescription, historyItems, workflowHosts, activeTab, openTabs } = payload;

  return [
    "Create a step-by-step instruction list for the user's task.",
    "",
    "Task description:",
    taskDescription,
    "",
    "Active tab:",
    JSON.stringify(activeTab || {}, null, 2),
    "",
    "Open tabs:",
    JSON.stringify(openTabs || [], null, 2),
    "",
    "Workflow hosts (user-confirmed, includeAuth indicates session capture):",
    JSON.stringify(workflowHosts || [], null, 2),
    "",
    "Browsing history items (last 7 days, most recent first):",
    JSON.stringify(historyItems || [], null, 2),
    "",
    "Rules:",
    "- Output 3-12 steps when possible",
    "- Each step should be concrete and include a sourceUrl from history or open tabs",
    "- Prefer sources that match the task description",
    "- requiresSession = true for authenticated apps or when workflowHosts includeAuth for the host",
    "- If unsure, make requiresSession false"
  ].join("\n");
}

function buildStepsMarkdown({ taskDescription, steps }) {
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

function normalizeWorkflowStepsPayload(obj) {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  const payload = { ...obj };
  if (!Array.isArray(payload.steps) && Array.isArray(payload.workflowSteps)) {
    payload.steps = payload.workflowSteps;
    delete payload.workflowSteps;
  }

  if (!Array.isArray(payload.steps)) {
    return payload;
  }

  payload.steps = payload.steps.map((step) => ({
    text: typeof step.text === "string" ? step.text.trim() : step.text,
    sourceUrl: typeof step.sourceUrl === "string" ? step.sourceUrl.trim() : step.sourceUrl,
    sourceTitle: typeof step.sourceTitle === "string" ? step.sourceTitle.trim() : step.sourceTitle,
    requiresSession: Boolean(step.requiresSession)
  }));

  return payload;
}

async function repairToValidJson({ requestId, badText, originalPayload, schemaHint }) {
  const repairInstructions = [
    "You are a JSON repair tool.",
    `Output ONLY valid JSON matching: ${schemaHint}.`,
    "Do not add commentary."
  ].join("\n");

  const repairInput = [
    "The previous output was invalid or did not match schema.",
    "Here is the invalid output text:",
    badText,
    "",
    "Reconstruct valid JSON using the original inputs:",
    JSON.stringify(originalPayload, null, 2)
  ].join("\n");

  const messages = [
    { role: "system", content: repairInstructions },
    { role: "user", content: repairInput }
  ];

  const resp = await fireworksChatCompletions({
    requestId,
    model: FIREWORKS_MODEL,
    messages,
    max_tokens: 1200,
    temperature: 0,
    response_format: { type: "json_object" }
  });

  const text = extractMessageTextFromResponsesApi(resp);
  return parseJsonLoose(text);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/context/workflow-sites", async (req, res) => {
  const requestId = req.header("X-Request-Id") || crypto.randomUUID();

  try {
    const inputPayload = req.body || {};
    if (typeof inputPayload.taskDescription !== "string" || inputPayload.taskDescription.trim().length < 5) {
      return res.status(400).json({ error: "taskDescription is required" });
    }

    const instructions = buildSystemInstructions();
    const userPrompt = buildUserPrompt(inputPayload);

    let lastText = "";
    let obj = null;

    const messages = [
      { role: "system", content: instructions },
      { role: "user", content: userPrompt }
    ];

    const chatResp = await fireworksChatCompletions({
      requestId,
      model: FIREWORKS_MODEL,
      messages,
      max_tokens: 1200,
      temperature: 0.1,
      response_format: { type: "json_object" }
    });

    const chatText = extractMessageTextFromResponsesApi(chatResp);
    lastText = chatText;
    obj = normalizeWorkflowPayload(parseJsonLoose(chatText));

    if (!obj || !validateWorkflow(obj)) {
      const fwResp = await fireworksResponses({
        requestId,
        model: FIREWORKS_MODEL,
        instructions,
        input: userPrompt,
        max_output_tokens: 1200,
        temperature: 0.2
      });

      const text = extractMessageTextFromResponsesApi(fwResp);
      lastText = text;
      obj = normalizeWorkflowPayload(parseJsonLoose(text));
    }

    if (!obj || !validateWorkflow(obj)) {
      const repaired = await repairToValidJson({
        requestId,
        badText: lastText,
        originalPayload: inputPayload,
        schemaHint: "{ workflowHosts: [...] }"
      });

      const normalizedRepair = normalizeWorkflowPayload(repaired);
      if (normalizedRepair && validateWorkflow(normalizedRepair)) {
        return res.json({ requestId, workflow: normalizedRepair, repaired: true });
      }

      if (repaired && validateWorkflow(repaired)) {
        return res.json({ requestId, workflow: repaired, repaired: true });
      }

      return res.status(422).json({
        requestId,
        error: "Model output did not match schema",
        modelOutputPreview: lastText.slice(0, 1200),
        schemaErrors: validateWorkflow.errors || []
      });
    }

    return res.json({ requestId, workflow: obj, repaired: false });
  } catch (err) {
    console.error(`[${requestId}] error`, err?.message);
    return res.status(500).json({ requestId, error: String(err?.message || err) });
  }
});

app.post("/api/context/workflow-steps", async (req, res) => {
  const requestId = req.header("X-Request-Id") || crypto.randomUUID();

  try {
    const inputPayload = req.body || {};
    if (typeof inputPayload.taskDescription !== "string" || inputPayload.taskDescription.trim().length < 5) {
      return res.status(400).json({ error: "taskDescription is required" });
    }

    const instructions = buildStepsSystemInstructions();
    const userPrompt = buildStepsUserPrompt(inputPayload);

    let lastText = "";
    let obj = null;

    const messages = [
      { role: "system", content: instructions },
      { role: "user", content: userPrompt }
    ];

    const chatResp = await fireworksChatCompletions({
      requestId,
      model: FIREWORKS_MODEL,
      messages,
      max_tokens: 1400,
      temperature: 0,
      response_format: { type: "json_object" }
    });

    const chatText = extractMessageTextFromResponsesApi(chatResp);
    lastText = chatText;
    obj = normalizeWorkflowStepsPayload(parseJsonLoose(chatText));

    if (!obj || !validateWorkflowSteps(obj)) {
      const fwResp = await fireworksResponses({
        requestId,
        model: FIREWORKS_MODEL,
        instructions,
        input: userPrompt,
        max_output_tokens: 1400,
        temperature: 0.2
      });

      const text = extractMessageTextFromResponsesApi(fwResp);
      lastText = text;
      obj = normalizeWorkflowStepsPayload(parseJsonLoose(text));
    }

    if (!obj || !validateWorkflowSteps(obj)) {
      const repaired = await repairToValidJson({
        requestId,
        badText: lastText,
        originalPayload: inputPayload,
        schemaHint: "{ steps: [...] }"
      });

      const normalizedRepair = normalizeWorkflowStepsPayload(repaired);
      if (normalizedRepair && validateWorkflowSteps(normalizedRepair)) {
        return res.json({
          requestId,
          workflow: {
            ...normalizedRepair,
            markdown: buildStepsMarkdown({
              taskDescription: inputPayload.taskDescription,
              steps: normalizedRepair.steps
            })
          },
          repaired: true
        });
      }

      if (repaired && validateWorkflowSteps(repaired)) {
        return res.json({
          requestId,
          workflow: {
            ...repaired,
            markdown: buildStepsMarkdown({
              taskDescription: inputPayload.taskDescription,
              steps: repaired.steps
            })
          },
          repaired: true
        });
      }

      return res.status(422).json({
        requestId,
        error: "Model output did not match schema",
        modelOutputPreview: lastText.slice(0, 1200),
        schemaErrors: validateWorkflowSteps.errors || []
      });
    }

    return res.json({
      requestId,
      workflow: {
        ...obj,
        markdown: buildStepsMarkdown({
          taskDescription: inputPayload.taskDescription,
          steps: obj.steps
        })
      },
      repaired: false
    });
  } catch (err) {
    console.error(`[${requestId}] error`, err?.message);
    return res.status(500).json({ requestId, error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
  console.log(`Using Fireworks Responses endpoint ${FIREWORKS_BASE_URL}/responses`);
});
