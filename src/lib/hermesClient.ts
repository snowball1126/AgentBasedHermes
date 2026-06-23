export type HermesSkill = {
  name: string;
  description?: string;
  category?: string;
};

export type HermesToolset = {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  configured?: boolean;
  tools?: string[] | string;
};

export type StreamEvent = {
  event: string;
  data: unknown;
};

export type WorkflowPlanPayload = {
  agentId: string;
  agentName: string;
  title: string;
  reason: string;
};

export type WorkflowBranch = {
  agentId: string;
  agentName: string;
  branchPath: string;
  briefPath: string;
};

export type WorkflowRecord = {
  id: string;
  taskName: string;
  userRequest: string;
  date: string;
  projectPath: string;
  obsidianPath?: string;
  branches: WorkflowBranch[];
};

export type WorkflowAgentResult = {
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

export type EvaluationDomain = "algorithm" | "product" | "interface";

export type EvaluationScenario = {
  id: string;
  round: number;
  domain: EvaluationDomain;
  title: string;
  agentId: string;
  expectedAgents: string[];
  prompt: string;
  acceptanceCriteria: string[];
  evidenceRequired: string[];
  artifact?: {
    fileName: string;
    content: string;
  };
};

export type EvaluationCheck = {
  label: string;
  passed: boolean;
  evidence: string;
};

export type EvaluationScenarioResult = {
  scenarioId: string;
  round: number;
  domain: EvaluationDomain;
  title: string;
  agentId: string;
  expectedAgents: string[];
  score: number;
  passed: boolean;
  summary: string;
  checks: EvaluationCheck[];
  evidence: string[];
  artifacts: Array<{
    fileName: string;
    content: string;
  }>;
};

export type EvaluationRun = {
  runId: string;
  startedAt: string;
  finishedAt: string;
  evaluationPath: string;
  programsPath: string;
  reportPath: string;
  obsidianPath: string;
  total: number;
  passed: number;
  averageScore: number;
  domainBreakdown: Record<string, { total: number; passed: number; averageScore: number }>;
  results: EvaluationScenarioResult[];
};

export async function getHermesHealth() {
  const response = await fetch("/api/hermes/health");
  const payload = await safeJson(response);
  return {
    ok: response.ok && (payload.status === "ok" || payload.ok === true),
    status: response.status,
    payload
  };
}

export async function getCapabilities() {
  const response = await fetch("/api/hermes/capabilities");
  return safeJson(response);
}

export async function getSkills(): Promise<HermesSkill[]> {
  const response = await fetch("/api/hermes/skills");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload.data ?? payload.skills ?? [];
}

export async function getToolsets(): Promise<HermesToolset[]> {
  const response = await fetch("/api/hermes/toolsets");
  if (!response.ok) {
    throw new Error(await response.text());
  }
  const payload = await response.json();
  return Array.isArray(payload) ? payload : payload.data ?? payload.toolsets ?? [];
}

export async function getAgentMessages(agentId: string) {
  const response = await fetch(`/api/agents/${agentId}/messages`);
  return safeJson(response);
}

export async function streamAgentMessage(
  agentId: string,
  input: string,
  onEvent: (event: StreamEvent) => void,
  agentConfig?: string
) {
  const response = await fetch(`/api/agents/${agentId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input, agentConfig })
  });

  if (!response.ok || !response.body) {
    throw new Error(await response.text());
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\n\n|\r\n\r\n/);
    buffer = blocks.pop() ?? "";

    for (const block of blocks) {
      const parsed = parseSseBlock(block);
      if (parsed) {
        onEvent(parsed);
      }
    }
  }

  const final = parseSseBlock(buffer);
  if (final) {
    onEvent(final);
  }
}

export async function createWorkflow(userRequest: string, taskName: string, plan: WorkflowPlanPayload[]) {
  const response = await fetch("/api/workflows", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userRequest, taskName, plan })
  });
  const payload = await safeJson(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? "Unable to create workflow.");
  }
  return payload.workflow as WorkflowRecord;
}

export async function finalizeWorkflow(
  workflowId: string,
  parentResult: string,
  agentResults: WorkflowAgentResult[]
) {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentResult, agentResults })
  });
  const payload = await safeJson(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? "Unable to finalize workflow.");
  }
  return payload as {
    ok: true;
    projectReportPath: string;
    sourceMaterialsPath: string;
    obsidianPath: string;
    updatedExistingReport: boolean;
    workflow: WorkflowRecord;
  };
}

export async function runCodexWorker(input: {
  workflowId: string;
  agentId: string;
  title: string;
  prompt: string;
}) {
  const response = await fetch("/api/codex/workers/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
  const payload = await safeJson(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? "Unable to run Codex worker.");
  }
  return payload.result as {
    status: "done" | "blocked";
    output: string;
    exitCode: number | null;
    timedOut: boolean;
    stdoutPath: string;
    stderrPath: string;
    finalMessagePath: string;
    workerPromptPath: string;
    runMetaPath: string;
  };
}

export async function getEvaluationScenarios(): Promise<EvaluationScenario[]> {
  const response = await fetch("/api/evaluation/scenarios");
  const payload = await safeJson(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? "Unable to load evaluation scenarios.");
  }
  return payload.scenarios ?? [];
}

export async function runEvaluationSuite(): Promise<EvaluationRun> {
  const response = await fetch("/api/evaluation/run", { method: "POST" });
  const payload = await safeJson(response);
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? "Unable to run evaluation suite.");
  }
  return payload.run as EvaluationRun;
}

async function safeJson(response: Response) {
  const text = await response.text();
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function parseSseBlock(block: string): StreamEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (!dataLines.length) {
    return null;
  }

  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") {
    return { event: "done", data: { ok: true } };
  }

  try {
    return { event, data: JSON.parse(dataText) };
  } catch {
    return { event, data: dataText };
  }
}
