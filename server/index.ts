import "dotenv/config";
import { spawn } from "node:child_process";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import {
  evaluateScenario,
  evaluationScenarios,
  type EvaluationScenarioResult
} from "./evaluationScenarios";

type RuntimeLane = "hermes-core" | "codex-worker";

type SessionRecord = {
  id: string;
  title: string;
  createdAt: number;
};

type WorkflowPlanItem = {
  agentId: string;
  agentName?: string;
  title: string;
  reason?: string;
};

type WorkflowRecord = {
  id: string;
  taskName: string;
  userRequest: string;
  date: string;
  projectPath: string;
  obsidianPath?: string;
  branches: Array<{
    agentId: string;
    agentName: string;
    branchPath: string;
    briefPath: string;
  }>;
};

type WorkflowAgentResult = {
  agentId: string;
  agentName: string;
  title: string;
  status: string;
  result?: string;
  artifacts?: Array<{
    fileName: string;
    content: string;
  }>;
};

const app = express();
const port = Number(process.env.OFFICE_PROXY_PORT ?? 8787);
const hermesBase = (process.env.HERMES_API_BASE ?? "http://127.0.0.1:8642").replace(/\/+$/, "");
const hermesKey = process.env.HERMES_API_KEY;
const projectRoot = path.resolve(process.env.HERMES_OFFICE_PROJECTS_DIR ?? "projects");
const obsidianReportDir = process.env.OBSIDIAN_REPORT_DIR
  ? path.resolve(process.env.OBSIDIAN_REPORT_DIR)
  : path.join(projectRoot, "_obsidian-reports");
const codexCommand = process.env.CODEX_CLI_COMMAND ?? "codex";
const codexWorkerEnabled = (process.env.CODEX_WORKER_ENABLED ?? "true").toLowerCase() !== "false";
const codexWorkerTimeoutMs = Number(process.env.CODEX_WORKER_TIMEOUT_MS ?? 600000);
const codexWorkerModel = process.env.CODEX_WORKER_MODEL?.trim();
const codexWorkerSandbox = process.env.CODEX_WORKER_SANDBOX?.trim() || "danger-full-access";

const sessions = new Map<string, SessionRecord>();
const workflows = new Map<string, WorkflowRecord>();

const agentPrompts: Record<string, { title: string; runtime: RuntimeLane; instruction: string }> = {
  "hermes-agent": {
    title: "Hermes",
    runtime: "hermes-core",
    instruction:
      "You are Hermes, the PM, memory, dispatcher, and final submitter in a Marvis-style office. Accept the user's request, clarify goals, dispatch work to Codex worker agents, collect their results, maintain durable memory, and produce the final acceptance report. Do not pretend to perform coding work yourself."
  },
  "file-agent": {
    title: "File Agent",
    runtime: "codex-worker",
    instruction:
      "You are File Agent. Focus on local files, folders, naming, evidence locations, document organization, and project artifacts. For coding or file edits, operate as a Codex worker and report changed files plus verification."
  },
  "browser-agent": {
    title: "Browser Agent",
    runtime: "codex-worker",
    instruction:
      "You are Browser Agent. Focus on web research, source comparison, citations, and reliable external context. Source material should be concise enough to merge into the Obsidian final report."
  },
  "app-agent": {
    title: "App Agent",
    runtime: "codex-worker",
    instruction:
      "You are App Agent. Focus on application flows, UI behavior, integrations, automation, and product-level acceptance paths. For implementation tasks, operate as a Codex worker."
  },
  "computer-agent": {
    title: "Computer Agent",
    runtime: "codex-worker",
    instruction:
      "You are Computer Agent. Focus on local runtime, terminal commands, services, OS state, installation, and verification. Do not claim machine changes without tool evidence."
  },
  "search-agent": {
    title: "Search Agent",
    runtime: "codex-worker",
    instruction:
      "You are Search Agent. Focus on fast retrieval, query refinement, exact references, and evidence-backed facts. Your findings must be suitable for direct integration into the Obsidian report."
  }
};

app.use(express.json({ limit: "4mb" }));

app.use((_, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "http://127.0.0.1:5173");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
});

app.options(/.*/, (_, res) => {
  res.sendStatus(204);
});

app.get("/api/hermes/health", async (_, res) => {
  if (!hermesKey) {
    res.status(200).json({
      ok: false,
      apiKeyConfigured: false,
      error: "HERMES_API_KEY is missing. Copy .env.example to .env and set your API_SERVER_KEY."
    });
    return;
  }

  try {
    const upstream = await fetch(`${hermesBase}/health`);
    const text = await upstream.text();
    const payload = parseJsonText(text);
    const hermesOk =
      upstream.ok &&
      typeof payload === "object" &&
      payload !== null &&
      ((payload as Record<string, unknown>).status === "ok" || (payload as Record<string, unknown>).ok === true);

    res.status(200).json({
      ok: hermesOk,
      apiKeyConfigured: true,
      hermes: payload
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      apiKeyConfigured: true,
      error: error instanceof Error ? error.message : "Hermes gateway is not reachable."
    });
  }
});

app.get("/api/hermes/capabilities", async (_, res) => proxyJson("/v1/capabilities", res));
app.get("/api/hermes/skills", async (_, res) => proxyJson("/v1/skills", res));
app.get("/api/hermes/toolsets", async (_, res) => proxyJson("/v1/toolsets", res));

app.get("/api/evaluation/scenarios", (_, res) => {
  res.json({ ok: true, scenarios: evaluationScenarios });
});

app.post("/api/evaluation/run", async (_, res) => {
  try {
    const run = await runEvaluationSuite();
    res.json({ ok: true, run });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to run evaluation suite."
    });
  }
});

app.post("/api/workflows", async (req, res) => {
  try {
    const userRequest = typeof req.body?.userRequest === "string" ? req.body.userRequest.trim() : "";
    const taskName = compactTaskName(typeof req.body?.taskName === "string" ? req.body.taskName : userRequest);
    const plan = Array.isArray(req.body?.plan) ? (req.body.plan as WorkflowPlanItem[]) : [];
    if (!userRequest) {
      res.status(400).json({ ok: false, error: "userRequest is required" });
      return;
    }

    const date = localDateStamp();
    const id = `${date}-${toSafeName(taskName)}-${Math.random().toString(36).slice(2, 8)}`;
    const projectPath = path.join(projectRoot, id);
    const hermesPath = path.join(projectPath, "00-hermes");
    const branchesRoot = path.join(projectPath, "branches");
    const programsPath = path.join(projectPath, "programs");
    const reportsPath = path.join(projectPath, "reports");

    await fs.mkdir(hermesPath, { recursive: true });
    await fs.mkdir(branchesRoot, { recursive: true });
    await fs.mkdir(programsPath, { recursive: true });
    await fs.mkdir(reportsPath, { recursive: true });
    await fs.mkdir(obsidianReportDir, { recursive: true });

    const branches = [];
    for (const item of plan) {
      if (!item?.agentId || !item?.title) {
        continue;
      }

      const agentName = item.agentName ?? agentPrompts[item.agentId]?.title ?? item.agentId;
      const branchPath = path.join(branchesRoot, `${toSafeName(agentName)}-${toSafeName(item.agentId)}`);
      const briefPath = path.join(branchPath, "brief.md");
      await fs.mkdir(branchPath, { recursive: true });
      await fs.writeFile(briefPath, buildBranchBrief(id, taskName, userRequest, agentName, item), "utf8");
      branches.push({ agentId: item.agentId, agentName, branchPath, briefPath });
    }

    await fs.writeFile(path.join(hermesPath, "task-brief.md"), buildHermesBrief(id, date, taskName, userRequest, plan), "utf8");
    await fs.writeFile(
      path.join(programsPath, "README.md"),
      [
        "# Programs",
        "",
        "Generated apps, scripts, demos, and implementation artifacts stay in this folder.",
        "Worker branches should reference program files here in their result summaries."
      ].join("\n"),
      "utf8"
    );
    await fs.writeFile(
      path.join(projectPath, "README.md"),
      [`# ${taskName}`, "", `Created: ${new Date().toISOString()}`, "", "## Original Request", userRequest].join("\n"),
      "utf8"
    );

    const record: WorkflowRecord = {
      id,
      taskName,
      userRequest,
      date,
      projectPath,
      branches
    };
    workflows.set(id, record);
    res.json({ ok: true, workflow: record, obsidianReportDir });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to create workflow." });
  }
});

app.post("/api/workflows/:workflowId/finalize", async (req, res) => {
  try {
    const workflow = workflows.get(req.params.workflowId);
    if (!workflow) {
      res.status(404).json({ ok: false, error: "workflow not found" });
      return;
    }

    const parentResult = typeof req.body?.parentResult === "string" ? req.body.parentResult : "";
    const agentResults = Array.isArray(req.body?.agentResults)
      ? (req.body.agentResults as WorkflowAgentResult[])
      : [];
    const finishedAt = new Date().toISOString();
    const projectReportPath = path.join(workflow.projectPath, "reports", "final-report.md");
    const sourceMaterialsPath = path.join(workflow.projectPath, "reports", "source-materials.md");
    const obsidianPath = path.join(obsidianReportDir, `${workflow.date}-${toSafeName(workflow.taskName)}.md`);
    const updatedExistingReport = await fileExists(obsidianPath);
    const report = buildFinalReport(workflow, parentResult, agentResults, finishedAt, updatedExistingReport);

    await fs.mkdir(path.dirname(projectReportPath), { recursive: true });
    await fs.mkdir(obsidianReportDir, { recursive: true });
    await fs.writeFile(projectReportPath, report, "utf8");
    await fs.writeFile(sourceMaterialsPath, buildSourceMaterials(agentResults), "utf8");
    await fs.writeFile(obsidianPath, report, "utf8");

    for (const result of agentResults) {
      const branch = workflow.branches.find((item) => item.agentId === result.agentId);
      if (branch) {
        await fs.writeFile(path.join(branch.branchPath, "result.md"), buildBranchResult(branch.agentName, result), "utf8");
      }

      if (Array.isArray(result.artifacts)) {
        for (const artifact of result.artifacts) {
          const fileName = toSafeRelativeFileName(artifact.fileName);
          if (!fileName) {
            continue;
          }
          const artifactPath = path.join(workflow.projectPath, "programs", fileName);
          await fs.mkdir(path.dirname(artifactPath), { recursive: true });
          await fs.writeFile(artifactPath, artifact.content ?? "", "utf8");
        }
      }
    }

    workflow.obsidianPath = obsidianPath;
    workflows.set(workflow.id, workflow);
    res.json({ ok: true, projectReportPath, sourceMaterialsPath, obsidianPath, updatedExistingReport, workflow });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "Unable to finalize workflow." });
  }
});

app.post("/api/codex/workers/run", async (req, res) => {
  try {
    if (!codexWorkerEnabled) {
      res.status(503).json({ ok: false, error: "Codex worker execution is disabled." });
      return;
    }

    const workflowId = typeof req.body?.workflowId === "string" ? req.body.workflowId : "";
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId : "";
    const title = typeof req.body?.title === "string" ? req.body.title : "Codex worker task";
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    const workflow = workflows.get(workflowId);
    if (!workflow) {
      res.status(404).json({ ok: false, error: "workflow not found" });
      return;
    }

    const branch = workflow.branches.find((item) => item.agentId === agentId);
    if (!branch) {
      res.status(404).json({ ok: false, error: "worker branch not found" });
      return;
    }

    if (!isPathInside(projectRoot, workflow.projectPath) || !isPathInside(workflow.projectPath, branch.branchPath)) {
      res.status(400).json({ ok: false, error: "workflow path is outside the configured project root" });
      return;
    }

    const result = await runCodexWorker({
      workflow,
      branch,
      title,
      prompt
    });
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to run Codex worker."
    });
  }
});

app.get("/api/agents/:agentId/messages", async (req, res) => {
  if (!requireKey(res)) {
    return;
  }

  const session = sessions.get(req.params.agentId);
  if (!session) {
    res.json({ messages: [] });
    return;
  }

  try {
    const upstream = await hermesFetch(`/api/sessions/${encodeURIComponent(session.id)}/messages`);
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
  } catch (error) {
    res.status(502).json({
      messages: [],
      error: error instanceof Error ? error.message : "Unable to load Hermes session messages."
    });
  }
});

app.post("/api/agents/:agentId/message", async (req, res) => {
  if (!requireKey(res)) {
    return;
  }

  const input = typeof req.body?.input === "string" ? req.body.input.trim() : "";
  const customConfig = typeof req.body?.agentConfig === "string" ? req.body.agentConfig.trim() : "";
  if (!input) {
    res.status(400).json({ ok: false, error: "input is required" });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  try {
    const session = await createSession(req.params.agentId);
    writeSse(res, "office.session", { sessionId: session.id, agentId: req.params.agentId });

    const upstream = await hermesFetch(`/api/sessions/${encodeURIComponent(session.id)}/chat/stream`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hermes-Session-Key": `hermes-office:${req.params.agentId}`
      },
      body: JSON.stringify({ input: buildAgentInput(req.params.agentId, input, customConfig || undefined) })
    });

    if (!upstream.ok || !upstream.body) {
      writeSse(res, "office.error", { status: upstream.status, error: await upstream.text() });
      writeSse(res, "office.done", { ok: false });
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      res.write(Buffer.from(value));
    }

    writeSse(res, "office.done", { ok: true });
    res.end();
  } catch (error) {
    writeSse(res, "office.error", {
      error: error instanceof Error ? error.message : "Hermes stream failed."
    });
    writeSse(res, "office.done", { ok: false });
    res.end();
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(`[Hermes Office] proxy listening on http://127.0.0.1:${port}`);
  console.log(`[Hermes Office] forwarding to ${hermesBase}`);
  console.log(`[Hermes Office] projects at ${projectRoot}`);
  console.log(`[Hermes Office] Obsidian reports at ${obsidianReportDir}`);
});

function authHeaders(extra?: HeadersInit): HeadersInit {
  return {
    ...(extra ?? {}),
    ...(hermesKey ? { Authorization: `Bearer ${hermesKey}` } : {})
  };
}

function requireKey(res: express.Response): boolean {
  if (hermesKey) {
    return true;
  }

  res.status(500).json({
    ok: false,
    error: "HERMES_API_KEY is missing. Copy .env.example to .env and set your API_SERVER_KEY."
  });
  return false;
}

async function hermesFetch(route: string, init?: RequestInit) {
  return fetch(`${hermesBase}${route}`, {
    ...init,
    headers: authHeaders(init?.headers)
  });
}

async function proxyJson(route: string, res: express.Response) {
  if (!requireKey(res)) {
    return;
  }

  try {
    const upstream = await hermesFetch(route);
    const text = await upstream.text();
    res.status(upstream.status);
    res.type(upstream.headers.get("content-type") ?? "application/json");
    res.send(text);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to reach Hermes."
    });
  }
}

async function createSession(agentId: string): Promise<SessionRecord> {
  const existing = sessions.get(agentId);
  if (existing) {
    return existing;
  }

  const meta = agentPrompts[agentId] ?? agentPrompts["hermes-agent"];
  const title = `${meta.title} - Hermes Office`;
  const upstream = await hermesFetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      source: "hermes-office"
    })
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    const duplicateSessionId = parseDuplicateSessionId(errorText);
    if (duplicateSessionId) {
      const record = { id: duplicateSessionId, title: meta.title, createdAt: Date.now() };
      sessions.set(agentId, record);
      return record;
    }

    throw new Error(`Hermes session create failed: ${upstream.status} ${errorText}`);
  }

  const payload = (await upstream.json()) as unknown;
  const id = parseSessionId(payload);
  if (!id) {
    throw new Error("Hermes did not return a session id.");
  }

  const record = { id, title: meta.title, createdAt: Date.now() };
  sessions.set(agentId, record);
  return record;
}

function buildAgentInput(agentId: string, input: string, customConfig?: string) {
  const meta = agentPrompts[agentId] ?? agentPrompts["hermes-agent"];
  const codexRouting =
    meta.runtime === "codex-worker"
      ? [
          "This office uses Hermes as the memory/product-manager layer and Codex as the coding execution layer.",
          "For coding tasks, explicitly use or delegate to Codex coding capability when available.",
          "If Codex is unavailable, say so clearly and provide a handoff-ready task brief.",
          "Never claim code changes unless a tool/delegation result confirms them."
        ]
      : [
          "This office uses Hermes as the PM/memory layer and Codex worker agents as the execution layer.",
          "When implementation is needed, create clear worker briefs and final acceptance criteria."
        ];

  return [
    `Hermes Office role: ${meta.title}.`,
    `Runtime lane: ${meta.runtime}.`,
    meta.instruction,
    customConfig ? `User-defined agent configuration:\n${customConfig}` : "",
    ...codexRouting,
    "Answer as this office specialist while keeping access to normal Hermes tools, memory, skills, and toolsets.",
    "Quality protocol: every answer must include Conclusion, Evidence, Verification, Uncertainty, and Next Step. When the task involves code, include changed files or artifact paths plus exact test commands/results. When evidence is missing, say what is missing instead of guessing.",
    "",
    "User request:",
    input
  ]
    .filter(Boolean)
    .join("\n");
}

function buildHermesBrief(id: string, date: string, taskName: string, userRequest: string, plan: WorkflowPlanItem[]) {
  return [
    "# Hermes Task Brief",
    "",
    `- Workflow: ${id}`,
    `- Date: ${date}`,
    `- Task: ${taskName}`,
    "",
    "## User Request",
    userRequest,
    "",
    "## Dispatch Plan",
    ...(plan.length
      ? plan.map((item, index) => `${index + 1}. ${item.agentName ?? item.agentId}: ${item.title}`)
      : ["No worker branches were selected."]),
    "",
    "## Folder Contract",
    "- `00-hermes/`: PM brief, final acceptance, and memory-facing notes.",
    "- `branches/`: one Codex worker branch per Marvis-style agent.",
    "- `programs/`: runnable programs, generated code, scripts, or app artifacts.",
    "- `reports/`: final report and source material, mirrored into Obsidian.",
    "",
    "## Acceptance Protocol",
    "- Hermes accepts the task, defines scope, and assigns worker branches.",
    "- Worker branches must return conclusion, evidence, verification, uncertainty, and next step.",
    "- Hermes submits only after collecting worker outputs and saving the final report."
  ].join("\n");
}

function buildBranchBrief(
  workflowId: string,
  taskName: string,
  userRequest: string,
  agentName: string,
  item: WorkflowPlanItem
) {
  return [
    `# ${agentName} Branch Brief`,
    "",
    `- Workflow: ${workflowId}`,
    `- Task: ${taskName}`,
    `- Agent: ${agentName}`,
    `- Reason: ${item.reason ?? "Hermes dispatch"}`,
    "",
    "## Subtask",
    item.title,
    "",
    "## Original Request",
    userRequest,
    "",
    "## Deliverable",
    "- Write findings, code notes, verification, and risks into this branch.",
    "- Put generated programs or runnable files under `../../programs/` when implementation artifacts are produced.",
    "- Search/Browser findings must be concise enough to merge into the Obsidian final report.",
    "- Return a concise summary to Hermes for final acceptance.",
    "",
    "## Required Result Shape",
    "- Conclusion: what is done or blocked.",
    "- Evidence: files, commands, sources, screenshots, or exact observations.",
    "- Verification: tests/checks performed and their result.",
    "- Uncertainty: anything not verified or dependent on external state.",
    "- Next Step: the smallest action Hermes or the user should take next."
  ].join("\n");
}

function buildBranchResult(agentName: string, result: WorkflowAgentResult) {
  return [
    `# ${agentName} Result`,
    "",
    `- Status: ${result.status}`,
    `- Title: ${result.title}`,
    "",
    "## Result",
    result.result?.trim() || "No result text returned."
  ].join("\n");
}

function buildFinalReport(
  workflow: WorkflowRecord,
  parentResult: string,
  agentResults: WorkflowAgentResult[],
  finishedAt: string,
  updatedExistingReport: boolean
) {
  const sourceMaterials = buildSourceMaterials(agentResults);
  return [
    `# ${workflow.date}-${workflow.taskName}`,
    "",
    `- Workflow ID: ${workflow.id}`,
    `- Finished: ${finishedAt}`,
    `- Report mode: ${updatedExistingReport ? "updated existing Obsidian note" : "created new Obsidian note"}`,
    `- Project folder: ${workflow.projectPath}`,
    "",
    "## 原始任务",
    workflow.userRequest,
    "",
    "## Hermes 总控总结",
    parentResult.trim() || "Hermes did not return a separate PM summary.",
    "",
    "## 搜索资料整合",
    sourceMaterials,
    "",
    "## Agent 分支结果",
    ...(agentResults.length
      ? agentResults.flatMap((result) => [
          `### ${result.agentName}`,
          "",
          `- Status: ${result.status}`,
          `- Task: ${result.title}`,
          "",
          result.result?.trim() || "No result text returned.",
          ""
        ])
      : ["No worker results were captured."]),
    "## Acceptance Quality",
    `- Worker branches captured: ${agentResults.length}`,
    `- Done branches: ${agentResults.filter((result) => result.status === "done").length}`,
    `- Blocked branches: ${agentResults.filter((result) => result.status === "blocked").length}`,
    "- Required evidence shape: conclusion, evidence, verification, uncertainty, next step.",
    "",
    "## 文件与程序",
    `- Project folder: ${workflow.projectPath}`,
    `- Program folder: ${path.join(workflow.projectPath, "programs")}`,
    `- Branch folders: ${path.join(workflow.projectPath, "branches")}`,
    `- Source materials: ${path.join(workflow.projectPath, "reports", "source-materials.md")}`,
    "",
    "## 最终提交",
    "Hermes has collected worker outputs and mirrored this report into Obsidian."
  ].join("\n");
}

function buildSourceMaterials(agentResults: WorkflowAgentResult[]) {
  const sourceResults = agentResults.filter((result) =>
    ["search-agent", "browser-agent"].includes(result.agentId)
  );
  if (!sourceResults.length) {
    return "本次任务没有单独的 Search/Browser 资料分支。";
  }

  return sourceResults
    .map((result) =>
      [
        `### ${result.agentName}`,
        "",
        `- Status: ${result.status}`,
        `- Task: ${result.title}`,
        "",
        result.result?.trim() || "No source material returned."
      ].join("\n")
    )
    .join("\n\n");
}

async function runCodexWorker(input: {
  workflow: WorkflowRecord;
  branch: WorkflowRecord["branches"][number];
  title: string;
  prompt: string;
}) {
  const startedAt = new Date().toISOString();
  const finalMessagePath = path.join(input.branch.branchPath, "codex-final.md");
  const stdoutPath = path.join(input.branch.branchPath, "codex-stdout.jsonl");
  const stderrPath = path.join(input.branch.branchPath, "codex-stderr.log");
  const runMetaPath = path.join(input.branch.branchPath, "codex-run.json");
  const workerPromptPath = path.join(input.branch.branchPath, "codex-prompt.md");
  const prompt = buildCodexWorkerPrompt(input.workflow, input.branch, input.title, input.prompt);

  await fs.mkdir(input.branch.branchPath, { recursive: true });
  await fs.writeFile(workerPromptPath, prompt, "utf8");

  const args = [
    "exec",
    "--cd",
    input.workflow.projectPath,
    "--skip-git-repo-check",
    "--sandbox",
    codexWorkerSandbox,
    "--color",
    "never",
    "--output-last-message",
    finalMessagePath,
    "--json"
  ];
  if (codexWorkerModel) {
    args.push("--model", codexWorkerModel);
  }
  if (["browser-agent", "search-agent"].includes(input.branch.agentId)) {
    args.push("--search");
  }
  args.push("-");

  const execution = await runProcess(codexCommand, args, prompt, {
    cwd: input.workflow.projectPath,
    timeoutMs: codexWorkerTimeoutMs
  });
  const finishedAt = new Date().toISOString();

  await fs.writeFile(stdoutPath, execution.stdout, "utf8");
  await fs.writeFile(stderrPath, execution.stderr, "utf8");

  const finalMessage = await readTextIfExists(finalMessagePath);
  const output = finalMessage.trim() || extractLastCodexMessage(execution.stdout) || execution.stdout.trim();
  const status = execution.exitCode === 0 && !execution.timedOut ? "done" : "blocked";
  const meta = {
    command: codexCommand,
    args: redactArgsForLog(args),
    agentId: input.branch.agentId,
    branchPath: input.branch.branchPath,
    projectPath: input.workflow.projectPath,
    startedAt,
    finishedAt,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    stdoutPath,
    stderrPath,
    finalMessagePath,
    workerPromptPath
  };
  await fs.writeFile(runMetaPath, JSON.stringify(meta, null, 2), "utf8");

  return {
    status,
    output,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    stdoutPath,
    stderrPath,
    finalMessagePath,
    workerPromptPath,
    runMetaPath
  };
}

function buildCodexWorkerPrompt(
  workflow: WorkflowRecord,
  branch: WorkflowRecord["branches"][number],
  title: string,
  prompt: string
) {
  return [
    `You are ${branch.agentName}, a real Codex worker in the Hermes office.`,
    "",
    "Important execution rules:",
    "- Work inside the provided project folder. Treat the branch folder as your own workspace.",
    "- Save notes, reports, and evidence under your branch folder unless a runnable program is required.",
    "- Save runnable code, scripts, demos, or generated apps under the project `programs/` folder.",
    "- Do not edit files outside this project folder.",
    "- Do not claim a command, file edit, or test happened unless you actually performed it.",
    "- Keep the final answer concise and evidence-based.",
    "",
    "Required final response shape:",
    "Conclusion:",
    "Evidence:",
    "Verification:",
    "Uncertainty:",
    "Next Step:",
    "",
    `Workflow ID: ${workflow.id}`,
    `Task: ${workflow.taskName}`,
    `Project folder: ${workflow.projectPath}`,
    `Branch folder: ${branch.branchPath}`,
    `Programs folder: ${path.join(workflow.projectPath, "programs")}`,
    `Worker title: ${title}`,
    "",
    "Worker brief:",
    prompt,
    "",
    "Before finishing, write any useful worker report to your branch folder and mention the exact path in Evidence."
  ].join("\n");
}

function runProcess(
  command: string,
  args: string[],
  stdin: string,
  options: { cwd: string; timeoutMs: number }
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: process.platform === "win32",
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0"
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = windowlessSetTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

function windowlessSetTimeout(callback: () => void, ms: number) {
  return setTimeout(callback, ms);
}

function extractLastCodexMessage(stdout: string) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const event = JSON.parse(lines[index]) as Record<string, unknown>;
      const message = event.message;
      if (typeof message === "string") {
        return message;
      }
      if (event.type === "agent_message" && typeof event.text === "string") {
        return event.text;
      }
      if (typeof event.content === "string") {
        return event.content;
      }
    } catch {
      // Ignore non-JSON output from the CLI.
    }
  }
  return "";
}

function redactArgsForLog(args: string[]) {
  return args.map((arg) => (arg.length > 180 ? `${arg.slice(0, 180)}...` : arg));
}

async function readTextIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function isPathInside(parent: string, child: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function runEvaluationSuite() {
  const date = localDateStamp();
  const startedAt = new Date().toISOString();
  const runId = `${date}-hermes-agent-10-round-verification-${Math.random().toString(36).slice(2, 8)}`;
  const evaluationPath = path.join(projectRoot, "evaluations", runId);
  const hermesPath = path.join(evaluationPath, "00-hermes");
  const branchesRoot = path.join(evaluationPath, "branches");
  const programsPath = path.join(evaluationPath, "programs");
  const reportsPath = path.join(evaluationPath, "reports");

  await fs.mkdir(hermesPath, { recursive: true });
  await fs.mkdir(branchesRoot, { recursive: true });
  await fs.mkdir(programsPath, { recursive: true });
  await fs.mkdir(reportsPath, { recursive: true });
  await fs.mkdir(obsidianReportDir, { recursive: true });

  const results = evaluationScenarios.map((scenario) => evaluateScenario(scenario));
  const finishedAt = new Date().toISOString();
  const reportPath = path.join(reportsPath, "evaluation-report.md");
  const obsidianPath = path.join(obsidianReportDir, `${date}-Hermes-Agent-十轮验证.md`);

  await fs.writeFile(
    path.join(hermesPath, "evaluation-brief.md"),
    buildEvaluationBrief(runId, startedAt),
    "utf8"
  );

  for (const result of results) {
    const scenario = evaluationScenarios.find((item) => item.id === result.scenarioId);
    const branchPath = path.join(
      branchesRoot,
      `round-${String(result.round).padStart(2, "0")}-${toSafeName(result.agentId)}`
    );
    await fs.mkdir(branchPath, { recursive: true });
    await fs.writeFile(path.join(branchPath, "result.md"), buildEvaluationScenarioReport(result, scenario), "utf8");

    for (const artifact of result.artifacts) {
      const artifactPath = path.join(programsPath, toSafeRelativeFileName(artifact.fileName));
      await fs.mkdir(path.dirname(artifactPath), { recursive: true });
      await fs.writeFile(artifactPath, artifact.content, "utf8");
    }
  }

  const report = buildEvaluationReport({
    runId,
    startedAt,
    finishedAt,
    evaluationPath,
    programsPath,
    reportPath,
    obsidianPath,
    results
  });
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(obsidianPath, report, "utf8");

  const passed = results.filter((result) => result.passed).length;
  const averageScore = Math.round(results.reduce((sum, result) => sum + result.score, 0) / results.length);

  return {
    runId,
    startedAt,
    finishedAt,
    evaluationPath,
    programsPath,
    reportPath,
    obsidianPath,
    total: results.length,
    passed,
    averageScore,
    domainBreakdown: buildDomainBreakdown(results),
    results
  };
}

function buildEvaluationBrief(runId: string, startedAt: string) {
  return [
    "# Hermes Agent Verification Brief",
    "",
    `- Run ID: ${runId}`,
    `- Started: ${startedAt}`,
    "- Goal: verify the Hermes PM + Codex worker office with repeatable, evidence-first tasks.",
    "- Scope: 10 rounds covering algorithm programming, new product R&D, and interface design.",
    "",
    "## Quality Protocol",
    "- Every worker result must include conclusion, evidence, verification, uncertainty, and next step.",
    "- Algorithm rounds require deterministic assertions, not model self-evaluation.",
    "- Product and UI rounds require traceable acceptance criteria and evidence slots.",
    "- Final reports are mirrored into Obsidian with date + task name."
  ].join("\n");
}

function buildEvaluationScenarioReport(
  result: EvaluationScenarioResult,
  scenario?: (typeof evaluationScenarios)[number]
) {
  return [
    `# Round ${result.round}: ${result.title}`,
    "",
    `- Domain: ${domainLabel(result.domain)}`,
    `- Responsible Agent: ${agentPrompts[result.agentId]?.title ?? result.agentId}`,
    `- Score: ${result.score}`,
    `- Status: ${result.passed ? "passed" : "failed"}`,
    "",
    "## Prompt",
    scenario?.prompt ?? "",
    "",
    "## Acceptance Criteria",
    ...(scenario?.acceptanceCriteria.map((criterion) => `- ${criterion}`) ?? ["- Not specified"]),
    "",
    "## Checks",
    ...result.checks.map((check) => `- [${check.passed ? "x" : " "}] ${check.label}: ${check.evidence}`),
    "",
    "## Evidence",
    ...result.evidence.map((item) => `- ${item}`),
    "",
    "## Summary",
    result.summary
  ].join("\n");
}

function buildEvaluationReport(input: {
  runId: string;
  startedAt: string;
  finishedAt: string;
  evaluationPath: string;
  programsPath: string;
  reportPath: string;
  obsidianPath: string;
  results: EvaluationScenarioResult[];
}) {
  const passed = input.results.filter((result) => result.passed).length;
  const averageScore = Math.round(
    input.results.reduce((sum, result) => sum + result.score, 0) / input.results.length
  );
  const breakdown = buildDomainBreakdown(input.results);

  return [
    `# ${localDateStamp()}-Hermes-Agent-十轮验证`,
    "",
    `- Run ID: ${input.runId}`,
    `- Started: ${input.startedAt}`,
    `- Finished: ${input.finishedAt}`,
    `- Total: ${input.results.length}`,
    `- Passed: ${passed}/${input.results.length}`,
    `- Average Score: ${averageScore}`,
    `- Evaluation Folder: ${input.evaluationPath}`,
    `- Programs Folder: ${input.programsPath}`,
    `- Project Report: ${input.reportPath}`,
    `- Obsidian Note: ${input.obsidianPath}`,
    "",
    "## 结论",
    passed === input.results.length
      ? "十轮验证全部通过。当前 Hermes PM + Codex Worker 办公室具备可重复的任务拆解、证据留存、程序产物保存和 Obsidian 汇总能力。"
      : "验证未全部通过。需要优先修复失败轮次对应的 Agent 分支，再让 Hermes 重新汇总。",
    "",
    "## 分领域结果",
    ...Object.entries(breakdown).map(
      ([domain, value]) => `- ${domainLabel(domain as EvaluationScenarioResult["domain"])}: ${value.passed}/${value.total}, avg ${value.averageScore}`
    ),
    "",
    "## 十轮明细",
    ...input.results.flatMap((result) => [
      `### Round ${result.round}: ${result.title}`,
      "",
      `- Domain: ${domainLabel(result.domain)}`,
      `- Agent: ${agentPrompts[result.agentId]?.title ?? result.agentId}`,
      `- Expected Agents: ${result.expectedAgents.join(", ")}`,
      `- Score: ${result.score}`,
      `- Status: ${result.passed ? "passed" : "failed"}`,
      "",
      ...result.checks.map((check) => `- [${check.passed ? "x" : " "}] ${check.label}: ${check.evidence}`),
      ""
    ]),
    "## 程序产物",
    "- Algorithm rounds write runnable reference implementations into the `programs/` folder.",
    "- Non-algorithm rounds write branch reports under `branches/` with acceptance criteria and evidence slots.",
    "",
    "## Hermes 提交说明",
    "This report is generated by the local Hermes Office verification runner and mirrored into Obsidian for long-term memory."
  ].join("\n");
}

function buildDomainBreakdown(results: EvaluationScenarioResult[]) {
  return results.reduce<Record<string, { total: number; passed: number; averageScore: number }>>((acc, result) => {
    const current = acc[result.domain] ?? { total: 0, passed: 0, averageScore: 0 };
    const nextTotal = current.total + 1;
    acc[result.domain] = {
      total: nextTotal,
      passed: current.passed + (result.passed ? 1 : 0),
      averageScore: Math.round((current.averageScore * current.total + result.score) / nextTotal)
    };
    return acc;
  }, {});
}

function domainLabel(domain: EvaluationScenarioResult["domain"]) {
  if (domain === "algorithm") return "算法编程";
  if (domain === "product") return "新产品研发";
  return "界面设计";
}

function writeSse(res: express.Response, event: string, data: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function parseSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const value = payload as Record<string, unknown>;
  const candidates = [
    value.id,
    value.session_id,
    value.sessionId,
    value.session && typeof value.session === "object" ? (value.session as Record<string, unknown>).id : null
  ];

  const id = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
  return typeof id === "string" ? id : null;
}

function parseDuplicateSessionId(errorText: string): string | null {
  const match = errorText.match(/already in use by session\s+([A-Za-z0-9_-]+)/i);
  return match?.[1] ?? null;
}

function parseJsonText(text: string) {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function compactTaskName(input: string) {
  const text = input.replace(/\s+/g, " ").trim();
  if (!text) {
    return "untitled-task";
  }
  return text.length > 42 ? text.slice(0, 42) : text;
}

function toSafeName(input: string) {
  const safe = input
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return safe || "task";
}

function toSafeRelativeFileName(input: string) {
  const safeParts = input
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((part) => toSafeName(part))
    .filter((part) => part && part !== "." && part !== "..");
  return safeParts.join(path.sep);
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function localDateStamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
