import { Activity, CircleDot } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AgentDrawer } from "./components/AgentDrawer";
import { OfficeScene } from "./components/OfficeScene";
import { TaskLedger } from "./components/TaskLedger";
import { VerificationLab } from "./components/VerificationLab";
import { agents, getAgentById, type AgentProfile, type AgentStatus } from "./data/agents";
import {
  createWorkflow,
  finalizeWorkflow,
  getCapabilities,
  getHermesHealth,
  getSkills,
  getToolsets,
  runCodexWorker,
  streamAgentMessage,
  type HermesSkill,
  type HermesToolset,
  type StreamEvent,
  type WorkflowAgentResult,
  type WorkflowRecord
} from "./lib/hermesClient";
import "./styles.css";
import type { ChatMessage, TaskEvent, TaskItem, TaskStatus } from "./types";

type ConnectionState = {
  ok: boolean;
  label: string;
  detail: string;
};

type DispatchPlanItem = {
  agentId: string;
  title: string;
  reason: string;
  prompt: string;
};

type TaskOutcome = {
  taskId: string;
  agentId: string;
  title: string;
  status: TaskStatus;
  result: string;
};

type AgentConfigOverrides = Record<string, { configMarkdown?: string; role?: string }>;

const workerAgentIds = ["file-agent", "browser-agent", "app-agent", "computer-agent", "search-agent"];
const initialStatuses = Object.fromEntries(agents.map((agent) => [agent.id, "offline" as AgentStatus]));
const agentConfigStorageKey = "hermes-office-agent-configs";

export default function App() {
  if (window.location.pathname.startsWith("/verify")) {
    return <VerificationLab />;
  }

  return <OfficeApp />;
}

function OfficeApp() {
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0].id);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, AgentStatus>>(initialStatuses);
  const [connection, setConnection] = useState<ConnectionState>({
    ok: false,
    label: "Checking",
    detail: "正在连接 Hermes gateway"
  });
  const [skills, setSkills] = useState<HermesSkill[]>([]);
  const [toolsets, setToolsets] = useState<HermesToolset[]>([]);
  const [capabilities, setCapabilities] = useState<unknown>(null);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [messagesByAgent, setMessagesByAgent] = useState<Record<string, ChatMessage[]>>({});
  const [taskFilter, setTaskFilter] = useState<TaskStatus | "all">("all");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [agentConfigs, setAgentConfigs] = useState<AgentConfigOverrides>(() => loadAgentConfigs());

  const effectiveAgents = useMemo(
    () =>
      agents.map((agent) => ({
        ...agent,
        role: agentConfigs[agent.id]?.role ?? agent.role,
        configMarkdown: agentConfigs[agent.id]?.configMarkdown ?? agent.configMarkdown
      })),
    [agentConfigs]
  );

  const resolveAgent = (agentId: string): AgentProfile =>
    effectiveAgents.find((agent) => agent.id === agentId) ?? effectiveAgents[0];
  const selectedAgent = resolveAgent(selectedAgentId);
  const selectedMessages = messagesByAgent[selectedAgentId] ?? [];
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) : null;

  const activeTasksByAgent = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const task of tasks) {
      if ((task.status === "running" || task.status === "queued") && !map[task.agentId]) {
        map[task.agentId] = compactDeskLabel(task.title);
      }
    }
    return map;
  }, [tasks]);

  useEffect(() => {
    void refreshHermesState();
    const timer = window.setInterval(() => {
      void refreshHermesState();
    }, 12000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshHermesState() {
    try {
      const health = await getHermesHealth();
      const isOk = health.ok;
      setConnection({
        ok: isOk,
        label: isOk ? "Connected" : "Offline",
        detail: isOk ? "Hermes gateway 已连接" : "未连接到 Hermes gateway"
      });

      setStatuses((current) =>
        Object.fromEntries(
          agents.map((agent) => {
            const currentStatus = current[agent.id];
            if (currentStatus === "busy" || currentStatus === "blocked") {
              return [agent.id, currentStatus];
            }
            return [agent.id, isOk ? "online" : "offline"];
          })
        )
      );

      if (isOk) {
        const [nextCapabilities, nextSkills, nextToolsets] = await Promise.all([
          getCapabilities().catch(() => null),
          getSkills().catch(() => []),
          getToolsets().catch(() => [])
        ]);
        setCapabilities(nextCapabilities);
        setSkills(nextSkills);
        setToolsets(nextToolsets);
      }
    } catch (error) {
      setConnection({
        ok: false,
        label: "Offline",
        detail: error instanceof Error ? error.message : "Hermes gateway 不可用"
      });
      setStatuses(Object.fromEntries(agents.map((agent) => [agent.id, "offline" as AgentStatus])));
    }
  }

  function openAgent(agentId: string) {
    setSelectedAgentId(agentId);
    setDrawerOpen(true);
  }

  async function handleSend(agentId: string, input: string) {
    if (agentId === "hermes-agent") {
      if (shouldDispatchToWorkers(input)) {
        await handleHermesWorkflow(input);
        return;
      }

      await runAgentTask(agentId, input, {
        title: `Hermes 对话：${compactTitle(input)}`,
        initialEvents: [makeTaskEvent("日常对话", "仅由 Hermes 回复，未派发 Codex worker")]
      });
      return;
    }
    await runAgentTask(agentId, input);
  }

  async function handleHermesWorkflow(input: string) {
    const taskName = compactTitle(input);
    const routingOutcome = await runAgentTask("hermes-agent", buildRoutingDecisionPrompt(input), {
      title: `Hermes 判断分派：${taskName}`,
      visibleInput: input,
      initialEvents: [
        makeTaskEvent("判断任务复杂度", "Hermes 正在决定是否需要 Codex worker"),
        makeTaskEvent("选择执行工位", "只会派发给必要的 Agent")
      ]
    });
    const plan = parseHermesDispatchPlan(routingOutcome.result, input);
    if (!plan.length) {
      appendTaskEvent(routingOutcome.taskId, makeTaskEvent("Hermes 决定直答", "未创建 worker 分支"));
      return;
    }
    const workflow = await createWorkflow(
      input,
      taskName,
      plan.map((item) => ({
        agentId: item.agentId,
        agentName: resolveAgent(item.agentId).name,
        title: item.title,
        reason: item.reason
      }))
    );
    const branchByAgent = Object.fromEntries(workflow.branches.map((branch) => [branch.agentId, branch]));
    const parentTaskId = crypto.randomUUID();
    const dispatchLines = plan
      .map((item, index) => `${index + 1}. ${resolveAgent(item.agentId).name}: ${item.title}`)
      .join("\n");

    const dispatchOutcome = await runAgentTask(
      "hermes-agent",
      [
        "用户把下面这个总任务交给你。你是 Hermes PM、记忆中枢和最终验收人。",
        `本地代理已经创建任务项目文件夹，并为 ${plan.length} 个必要 Codex worker 建立分支目录。`,
        "请先完成需求澄清、任务分发、验收标准和风险提示，不要假装已经执行 worker 的具体工作。",
        "质量协议：每个分支必须回传结论、证据、验证、不确定性和下一步；最终提交必须说明报告和程序保存位置。",
        "",
        `项目文件夹：${workflow.projectPath}`,
        "",
        "总任务：",
        input,
        "",
        "派发计划：",
        dispatchLines
      ].join("\n"),
      {
        taskId: parentTaskId,
        workflowId: workflow.id,
        projectPath: workflow.projectPath,
        visibleInput: input,
        title: `Hermes 接单：${taskName}`,
        initialEvents: [
          makeTaskEvent("创建任务项目", workflow.projectPath),
          makeTaskEvent("建立 Codex 分支", `${workflow.branches.length} 个 worker 分支已准备`),
          ...plan.map((item) => makeTaskEvent(`派发给 ${resolveAgent(item.agentId).name}`, item.title))
        ]
      }
    );

    const workerSettled = await Promise.allSettled(
      plan.map((item, index) =>
        delay(260 + index * 260).then(() => {
          const branch = branchByAgent[item.agentId];
          return runCodexWorkerTask(item, workflow, {
            parentId: parentTaskId,
            projectPath: workflow.projectPath,
            branchPath: branch?.branchPath
          });
        })
      )
    );

    const workerOutcomes = workerSettled.map((settled, index): TaskOutcome => {
      const fallback = plan[index];
      if (settled.status === "fulfilled") {
        return settled.value;
      }
      return {
        taskId: crypto.randomUUID(),
        agentId: fallback.agentId,
        title: fallback.title,
        status: "blocked",
        result: settled.reason instanceof Error ? settled.reason.message : "worker failed"
      };
    });

    const finalOutcome = await runAgentTask("hermes-agent", buildFinalHermesPrompt(input, workflow, dispatchOutcome, workerOutcomes), {
      parentId: parentTaskId,
      workflowId: workflow.id,
      projectPath: workflow.projectPath,
      title: `Hermes 提交：${taskName}`,
      visibleInput: `${workerOutcomes.length} 个 Codex worker 已回传结果，请做最终提交。`,
      initialEvents: [
        makeTaskEvent("收集 worker 结果", `${workerOutcomes.length} 个分支已回传`),
        makeTaskEvent("准备最终报告", "Hermes 正在进行验收总结")
      ]
    });

    const agentResults: WorkflowAgentResult[] = workerOutcomes.map((outcome) => ({
      agentId: outcome.agentId,
      agentName: resolveAgent(outcome.agentId).name,
      title: outcome.title,
      status: outcome.status,
      result: outcome.result
    }));

    try {
      const finalized = await finalizeWorkflow(workflow.id, finalOutcome.result, agentResults);
      updateTask(finalOutcome.taskId, {
        reportPath: finalized.projectReportPath,
        obsidianPath: finalized.obsidianPath,
        result: [
          finalOutcome.result,
          "",
          `项目报告：${finalized.projectReportPath}`,
          `资料整合：${finalized.sourceMaterialsPath}`,
          `Obsidian：${finalized.obsidianPath}`
        ].join("\n")
      });
      appendTaskEvent(finalOutcome.taskId, makeTaskEvent("报告已保存", finalized.obsidianPath));
      appendTaskEvent(parentTaskId, makeTaskEvent("Hermes 已提交", finalized.obsidianPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : "报告保存失败";
      appendTaskEvent(finalOutcome.taskId, makeTaskEvent("报告保存失败", message));
      updateTask(finalOutcome.taskId, { status: "blocked", result: `${finalOutcome.result}\n\n${message}` });
    }
  }

  async function runAgentTask(
    agentId: string,
    input: string,
    options: {
      taskId?: string;
      parentId?: string;
      workflowId?: string;
      projectPath?: string;
      branchPath?: string;
      title?: string;
      visibleInput?: string;
      initialEvents?: TaskEvent[];
    } = {}
  ): Promise<TaskOutcome> {
    const now = new Date().toISOString();
    const taskId = options.taskId ?? crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const title = options.title ?? compactTitle(input);
    const visibleInput = options.visibleInput ?? input;
    let assistantText = "";
    let blocked = false;

    setSelectedTaskId(null);
    setStatuses((current) => ({ ...current, [agentId]: "busy" }));
    appendMessage(agentId, {
      id: crypto.randomUUID(),
      agentId,
      role: "user",
      content: visibleInput,
      createdAt: now
    });
    appendMessage(agentId, {
      id: assistantMessageId,
      agentId,
      role: "assistant",
      content: "",
      createdAt: now
    });
    setTasks((current) => [
      {
        id: taskId,
        title,
        agentId,
        parentId: options.parentId,
        workflowId: options.workflowId,
        projectPath: options.projectPath,
        branchPath: options.branchPath,
        status: "running",
        progress: 6,
        createdAt: now,
        events: options.initialEvents ?? [makeTaskEvent("发送到 Hermes", "正在创建或复用该工位的 session")]
      },
      ...current
    ]);

    try {
      await streamAgentMessage(
        agentId,
        input,
        (event) => {
          const delta = extractAssistantDelta(event);
          if (delta) {
            assistantText = mergeAssistantText(assistantText, delta);
            updateAssistantMessage(agentId, assistantMessageId, assistantText);
            updateTask(taskId, {
              progress: Math.min(92, 18 + assistantText.length / 10)
            });
          }

          const timelineEvent = toTaskEvent(event);
          if (timelineEvent) {
            appendTaskEvent(taskId, timelineEvent);
            updateTask(taskId, {
              progress: progressFromEvent(event)
            });
          }

          if (event.event.includes("error")) {
            blocked = true;
            const errorText = stringifyEventData(event.data);
            assistantText += `\n\nHermes error: ${errorText}`;
            updateAssistantMessage(agentId, assistantMessageId, assistantText);
          }
        },
        resolveAgent(agentId).configMarkdown
      );

      if (blocked) {
        const result = assistantText.trim() || "Hermes 返回错误，任务已阻塞。";
        updateTask(taskId, {
          status: "blocked",
          progress: 100,
          completedAt: new Date().toISOString(),
          result
        });
        setStatuses((current) => ({ ...current, [agentId]: "blocked" }));
        return { taskId, agentId, title, status: "blocked", result };
      }

      const result = assistantText.trim() || "Hermes 已完成执行。";
      updateTask(taskId, {
        status: "done",
        progress: 100,
        completedAt: new Date().toISOString(),
        result
      });
      appendTaskEvent(taskId, makeTaskEvent("任务完成", "Hermes 已结束本轮执行"));
      setStatuses((current) => ({ ...current, [agentId]: "done" }));
      window.setTimeout(() => {
        setStatuses((current) => ({ ...current, [agentId]: connection.ok ? "online" : "offline" }));
      }, 1800);
      return { taskId, agentId, title, status: "done", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求 Hermes 失败";
      updateAssistantMessage(agentId, assistantMessageId, `Hermes connection failed.\n\n${message}`);
      updateTask(taskId, {
        status: "blocked",
        progress: 100,
        completedAt: new Date().toISOString(),
        result: message
      });
      appendTaskEvent(taskId, makeTaskEvent("请求失败", message));
      setStatuses((current) => ({ ...current, [agentId]: "blocked" }));
      return { taskId, agentId, title, status: "blocked", result: message };
    }
  }

  async function runCodexWorkerTask(
    item: DispatchPlanItem,
    workflow: WorkflowRecord,
    options: {
      parentId: string;
      projectPath: string;
      branchPath?: string;
    }
  ): Promise<TaskOutcome> {
    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();
    const agent = resolveAgent(item.agentId);

    setStatuses((current) => ({ ...current, [item.agentId]: "busy" }));
    appendMessage(item.agentId, {
      id: crypto.randomUUID(),
      agentId: item.agentId,
      role: "user",
      content: `Hermes 派发：${item.title}`,
      createdAt: now
    });
    appendMessage(item.agentId, {
      id: assistantMessageId,
      agentId: item.agentId,
      role: "assistant",
      content: "Codex worker 正在对应分支中执行...",
      createdAt: now
    });
    setTasks((current) => [
      {
        id: taskId,
        title: item.title,
        agentId: item.agentId,
        parentId: options.parentId,
        workflowId: workflow.id,
        projectPath: options.projectPath,
        branchPath: options.branchPath,
        status: "running",
        progress: 12,
        createdAt: now,
        events: [
          makeTaskEvent("Hermes 已派发", item.reason),
          makeTaskEvent("绑定分支目录", options.branchPath ?? "分支目录不可用"),
          makeTaskEvent("启动 Codex CLI", "正在以真实 Codex worker 执行")
        ]
      },
      ...current
    ]);

    try {
      const result = await runCodexWorker({
        workflowId: workflow.id,
        agentId: item.agentId,
        title: item.title,
        prompt: item.prompt
      });
      const output = [
        result.output,
        "",
        "Codex artifacts:",
        `- Final message: ${result.finalMessagePath}`,
        `- Stdout: ${result.stdoutPath}`,
        `- Stderr: ${result.stderrPath}`,
        `- Run metadata: ${result.runMetaPath}`
      ].join("\n");
      const status: TaskStatus = result.status === "done" ? "done" : "blocked";

      updateAssistantMessage(item.agentId, assistantMessageId, output);
      updateTask(taskId, {
        status,
        progress: 100,
        completedAt: new Date().toISOString(),
        result: output
      });
      appendTaskEvent(taskId, makeTaskEvent("Codex 执行完成", result.finalMessagePath));
      appendTaskEvent(taskId, makeTaskEvent("退出码", String(result.exitCode)));
      setStatuses((current) => ({ ...current, [item.agentId]: status === "done" ? "done" : "blocked" }));
      window.setTimeout(() => {
        setStatuses((current) => ({ ...current, [item.agentId]: connection.ok ? "online" : "offline" }));
      }, 1800);
      return { taskId, agentId: item.agentId, title: item.title, status, result: output };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Codex worker failed";
      updateAssistantMessage(item.agentId, assistantMessageId, `Codex worker failed.\n\n${message}`);
      updateTask(taskId, {
        status: "blocked",
        progress: 100,
        completedAt: new Date().toISOString(),
        result: message
      });
      appendTaskEvent(taskId, makeTaskEvent("Codex 执行失败", message));
      setStatuses((current) => ({ ...current, [item.agentId]: "blocked" }));
      return { taskId, agentId: item.agentId, title: item.title, status: "blocked", result: message };
    }
  }

  function appendMessage(agentId: string, message: ChatMessage) {
    setMessagesByAgent((current) => ({
      ...current,
      [agentId]: [...(current[agentId] ?? []), message]
    }));
  }

  function updateAssistantMessage(agentId: string, messageId: string, content: string) {
    setMessagesByAgent((current) => ({
      ...current,
      [agentId]: (current[agentId] ?? []).map((message) =>
        message.id === messageId ? { ...message, content } : message
      )
    }));
  }

  function updateTask(taskId: string, patch: Partial<TaskItem>) {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              ...patch,
              progress: patch.progress === undefined ? task.progress : Math.max(task.progress, patch.progress)
            }
          : task
      )
    );
  }

  function appendTaskEvent(taskId: string, event: TaskEvent) {
    setTasks((current) =>
      current.map((task) =>
        task.id === taskId
          ? {
              ...task,
              events: [...task.events, event]
            }
          : task
      )
    );
  }

  function completeTask(taskId: string) {
    updateTask(taskId, {
      status: "done",
      progress: 100,
      completedAt: new Date().toISOString(),
      result: "手动标记完成"
    });
    appendTaskEvent(taskId, makeTaskEvent("手动完成", "用户在全局待办工作表中标记完成"));
  }

  function saveAgentConfig(agentId: string, configMarkdown: string) {
    setAgentConfigs((current) => {
      const next = {
        ...current,
        [agentId]: {
          ...current[agentId],
          configMarkdown
        }
      };
      persistAgentConfigs(next);
      return next;
    });
  }

  function resetAgentConfig(agentId: string) {
    setAgentConfigs((current) => {
      const next = { ...current };
      delete next[agentId];
      persistAgentConfigs(next);
      return next;
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Hermes navigation">
        <div className="brand">
          <span className="brand-mark">H</span>
          <strong>Hermes</strong>
        </div>

        <div className="sidebar-section agent-roster">
          {effectiveAgents.map((agent) => (
            <button
              type="button"
              key={agent.id}
              className={`agent-shortcut ${selectedAgentId === agent.id ? "is-active" : ""}`}
              onClick={() => openAgent(agent.id)}
            >
              <span style={{ background: agent.accent }} />
              <strong>{agent.name}</strong>
            </button>
          ))}
        </div>

        <div className="sidebar-footer">
          <div className={`connection-pill ${connection.ok ? "is-ok" : "is-offline"}`}>
            <CircleDot size={14} />
            <span>{connection.label}</span>
          </div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-status">
            <Activity size={16} />
            <span>{connection.detail}</span>
          </div>
          <div className="topbar-paths">
            <span>HermesTry</span>
            <span>Obsidian reports</span>
          </div>
        </header>

        <div className="main-grid">
          <OfficeScene
            agents={effectiveAgents}
            statuses={statuses}
            activeAgentId={selectedAgentId}
            activeTasksByAgent={activeTasksByAgent}
            onSelectAgent={openAgent}
          />
          <TaskLedger
            tasks={tasks}
            agents={effectiveAgents}
            skillsCount={skills.length}
            toolsetsCount={toolsets.length}
            activeFilter={taskFilter}
            selectedTaskId={selectedTaskId}
            onFilterChange={setTaskFilter}
            onSelectTask={setSelectedTaskId}
            onCompleteTask={completeTask}
          />
        </div>
      </section>

      <AgentDrawer
        agent={selectedAgent}
        status={statuses[selectedAgent.id] ?? "offline"}
        open={drawerOpen}
        messages={selectedMessages}
        tasks={tasks}
        skills={skills}
        toolsets={toolsets}
        connectionOk={connection.ok}
        onClose={() => setDrawerOpen(false)}
        onSend={handleSend}
        onSaveConfig={saveAgentConfig}
        onResetConfig={resetAgentConfig}
      />

      {selectedTask ? (
        <div className="task-popover" role="dialog" aria-label="Task details">
          <button type="button" onClick={() => setSelectedTaskId(null)}>
            Close
          </button>
          <span>{resolveAgent(selectedTask.agentId).name}</span>
          <strong>{selectedTask.title}</strong>
          <p>{selectedTask.result ?? "任务仍在执行中。"}</p>
          {selectedTask.projectPath ? <small>项目：{selectedTask.projectPath}</small> : null}
          {selectedTask.branchPath ? <small>分支：{selectedTask.branchPath}</small> : null}
          {selectedTask.obsidianPath ? <small>Obsidian：{selectedTask.obsidianPath}</small> : null}
        </div>
      ) : null}

      <span className="sr-only">{capabilities ? "Capabilities loaded" : "Capabilities not loaded"}</span>
    </div>
  );
}

function buildFinalHermesPrompt(
  input: string,
  workflow: WorkflowRecord,
  dispatchOutcome: TaskOutcome,
  workerOutcomes: TaskOutcome[]
) {
  const workerSummary = workerOutcomes
    .map((outcome) => {
      const agent = getAgentById(outcome.agentId);
      return [
        `## ${agent.name}`,
        `状态：${outcome.status}`,
        `任务：${outcome.title}`,
        "结果：",
        outcome.result || "无返回"
      ].join("\n");
    })
    .join("\n\n");

  return [
    "五个 Codex worker 分支已经完成或阻塞。你现在作为 Hermes PM 做最终验收和提交。",
    "请输出一份可以直接保存到 Obsidian 的最终报告：结论、已完成事项、搜索资料整合、程序/文件位置、未完成风险、下一步建议。",
    "验收要求：明确每个结论的证据来源；列出实际验证过的命令、截图、文件或来源；把未验证信息放到不确定性；不要把 worker 没完成的事写成已完成。",
    "",
    `项目文件夹：${workflow.projectPath}`,
    `程序目录：${workflow.projectPath}\\programs`,
    "",
    "原始任务：",
    input,
    "",
    "Hermes 接单阶段输出：",
    dispatchOutcome.result,
    "",
    "Worker 分支结果：",
    workerSummary
  ].join("\n");
}

function buildRoutingDecisionPrompt(input: string) {
  return [
    "你是 Hermes PM。请先判断用户请求是否需要 Codex worker 分支协作。",
    "如果只是问候、闲聊、确认、解释你的能力，不要派发 worker。",
    "如果是复杂任务，请只选择必要的 worker，不要默认全选。",
    "",
    "可选 worker:",
    "- file-agent: 本地文件、目录、资料整理、报告落盘、证据定位。",
    "- browser-agent: 外部网页、资料来源、联网研究、引用对比。",
    "- app-agent: 产品流程、界面交互、应用集成、新产品研发。",
    "- computer-agent: 本机环境、命令执行、服务启动、程序运行、测试验证。",
    "- search-agent: 快速检索、关键词、线索定位、代码库搜索。",
    "",
    "请先给一句简短解释，然后必须输出一个 JSON 代码块，格式如下：",
    "```json",
    "{",
    "  \"mode\": \"direct\" | \"dispatch\",",
    "  \"agents\": [",
    "    {\"agentId\": \"app-agent\", \"title\": \"子任务标题\", \"reason\": \"为什么需要它\"}",
    "  ]",
    "}",
    "```",
    "",
    "规则：",
    "- direct 表示只由 Hermes 自己处理。",
    "- dispatch 表示需要 worker；agents 最少 1 个，最多 5 个。",
    "- 只选与任务真正相关的 Agent。",
    "",
    "用户请求：",
    input
  ].join("\n");
}

function buildDispatchPlan(input: string): DispatchPlanItem[] {
  const text = input.toLowerCase();
  const isCodeLike = /代码|实现|修复|bug|测试|构建|编程|仓库|前端|后端|codex|repo|npm|vite|react|python|node/i.test(
    input
  );
  const isResearchLike = /网页|浏览器|互联网|网址|链接|最新|官网|研究|资料|web|browser|url/i.test(text);
  const isFileLike = /文件|目录|文档|资料|pdf|md|路径|读取|整理|检索|本地|file|folder|doc/i.test(text);

  const specs = [
    {
      agentId: "file-agent",
      title: isFileLike || isCodeLike ? "整理本地文件、资料边界和可保存产物" : "确认文件、资料和报告保存边界",
      reason: "负责项目文件夹、资料整理、分支产物和可追溯路径"
    },
    {
      agentId: "browser-agent",
      title: isResearchLike ? "检索外部资料并整理可靠来源" : "判断是否需要外部资料补充",
      reason: "负责网页资料、来源比较和引用质量"
    },
    {
      agentId: "app-agent",
      title: "规划产品流程、界面交互和交付闭环",
      reason: "负责把目标转成可使用的应用流程和验收体验"
    },
    {
      agentId: "computer-agent",
      title: isCodeLike ? "检查运行环境、服务状态和执行步骤" : "确认本机执行条件与风险",
      reason: "负责本机环境、命令、服务和程序运行条件"
    },
    {
      agentId: "search-agent",
      title: "快速定位关键线索、优先级和风险点",
      reason: "负责建立信息线索、关键词、来源和任务优先级"
    }
  ];

  const selected = selectFallbackWorkerIds(input);
  return specs
    .filter((spec) => workerAgentIds.includes(spec.agentId) && selected.has(spec.agentId))
    .map((spec) => buildWorkerPlanItem(input, spec));
}

function parseHermesDispatchPlan(output: string, input: string): DispatchPlanItem[] {
  const jsonText = extractJsonBlock(output);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as {
        mode?: string;
        agents?: Array<{ agentId?: string; title?: string; reason?: string }>;
      };
      if (parsed.mode === "direct") {
        return [];
      }
      const planned = (parsed.agents ?? [])
        .filter((item) => item.agentId && workerAgentIds.includes(item.agentId))
        .map((item) =>
          buildWorkerPlanItem(input, {
            agentId: item.agentId as string,
            title: item.title?.trim() || `${getAgentById(item.agentId as string).name} 子任务`,
            reason: item.reason?.trim() || "Hermes selected this worker."
          })
        );
      if (planned.length) {
        return dedupePlan(planned);
      }
    } catch {
      // Fall back to local conservative routing when Hermes returns prose instead of JSON.
    }
  }

  return buildDispatchPlan(input);
}

function selectFallbackWorkerIds(input: string) {
  const text = input.toLowerCase();
  const selected = new Set<string>();
  const isCodeLike = /代码|实现|修复|bug|测试|构建|编程|仓库|前端|后端|repo|npm|vite|react|python|node|api|程序|脚本/i.test(
    input
  );
  const isResearchLike = /网页|浏览器|互联网|网址|链接|最新|官网|研究|资料|竞品|来源|web|browser|url/i.test(text);
  const isFileLike = /文件|目录|文档|资料|pdf|md|路径|读取|整理|检索|本地|file|folder|doc|obsidian|报告/i.test(text);
  const isProductLike = /产品|需求|prd|研发|方案|计划|流程|里程碑|用户|商业|原型/i.test(text);
  const isUiLike = /界面|ui|ux|页面|视觉|设计|交互|marvis|布局|样式|前端/i.test(text);
  const isSystemLike = /运行|启动|服务|环境|安装|配置|终端|命令|报错|错误|部署|电脑|本机/i.test(text);

  if (isFileLike || isCodeLike) selected.add("file-agent");
  if (isResearchLike) selected.add("browser-agent");
  if (isProductLike || isUiLike) selected.add("app-agent");
  if (isSystemLike || isCodeLike) selected.add("computer-agent");
  if (isResearchLike || isFileLike || isCodeLike || isProductLike) selected.add("search-agent");

  if (!selected.size) {
    selected.add("app-agent");
  }

  return selected;
}

function extractJsonBlock(output: string) {
  const fenced = output.match(/```json\s*([\s\S]*?)```/i) ?? output.match(/```\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return output.slice(start, end + 1);
  }
  return "";
}

function buildWorkerPlanItem(
  input: string,
  spec: {
    agentId: string;
    title: string;
    reason: string;
  }
): DispatchPlanItem {
  const agent = getAgentById(spec.agentId);
  return {
    ...spec,
    prompt: [
      "Hermes 已经把一个总任务拆给你。你是该任务项目文件夹下的一个 Codex worker 分支。",
      `你的工位：${agent.name}`,
      `派发原因：${spec.reason}`,
      `子任务：${spec.title}`,
      "",
      "原始总任务：",
      input,
      "",
      "交付要求：",
      "- 只处理属于你这个工位的部分。",
      "- 如果涉及代码、程序、脚本或配置，请以 Codex worker 的方式推进，并明确产物应保存到项目 programs 目录。",
      "- Search/Browser 资料要适合直接整合到 Obsidian 报告。",
      "- 输出给 Hermes 的内容要包含结论、证据、验证、不确定性、下一步、文件或程序位置。"
    ].join("\n")
  };
}

function dedupePlan(plan: DispatchPlanItem[]) {
  const seen = new Set<string>();
  return plan.filter((item) => {
    if (seen.has(item.agentId)) {
      return false;
    }
    seen.add(item.agentId);
    return true;
  });
}

function shouldDispatchToWorkers(input: string) {
  const text = input.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  if (!text) {
    return false;
  }

  const pureConversation =
    /^(hello|hi|hey|哈喽|嗨|你好|您好|在吗|ping|test|测试一下|早上好|晚上好|谢谢|ok|好的|收到)[!！。,.，?？\s]*$/i;
  if (pureConversation.test(text)) {
    return false;
  }

  const shortConversation =
    /^(hello|hi|hey|哈喽|嗨|你好|您好|在吗|你是谁|你能做什么|介绍一下|简单回复一句即可)/i;
  if (text.length <= 32 && shortConversation.test(text)) {
    return false;
  }

  const explicitDispatch =
    /派发|分发|调度|调用.*agent|调用.*worker|让.*agent|让.*worker|交给.*agent|交给.*worker|多\s*agent|codex\s*worker/i;
  if (explicitDispatch.test(text)) {
    return true;
  }

  const taskSignals =
    /帮我|请你|需要|做一个|实现|修改|修复|设计|生成|建立|创建|写一|查找|搜索|整理|分析|验证|测试|部署|运行|读取|保存|报告|计划|方案|研发|产品|界面|UI|代码|程序|文件|项目|Obsidian|浏览器|网页|API|bug|error|npm|vite|react|node|python/i;
  return taskSignals.test(lower);
}

function compactTitle(input: string) {
  const firstLine = input.replace(/\s+/g, " ").trim();
  return firstLine.length > 34 ? `${firstLine.slice(0, 34)}...` : firstLine || "新任务";
}

function compactDeskLabel(input: string) {
  const value = input.replace(/\s+/g, " ").replace(/^Hermes 派发：/, "").trim();
  return value.length > 9 ? `${value.slice(0, 9)}...` : value || "执行中";
}

function makeTaskEvent(label: string, detail?: string): TaskEvent {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    label,
    detail
  };
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function extractAssistantDelta(event: StreamEvent) {
  const data = event.data as Record<string, unknown> | string;
  if (typeof data === "string") {
    return event.event.includes("assistant") ? data : "";
  }

  const directCandidates = [data.delta, data.text, data.content, data.output_text];
  for (const candidate of directCandidates) {
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  if (data.delta && typeof data.delta === "object") {
    const delta = data.delta as Record<string, unknown>;
    if (typeof delta.content === "string") {
      return delta.content;
    }
    if (typeof delta.text === "string") {
      return delta.text;
    }
  }

  if (data.message && typeof data.message === "object") {
    const message = data.message as Record<string, unknown>;
    if (typeof message.content === "string" && event.event.includes("assistant")) {
      return message.content;
    }
  }

  return "";
}

function mergeAssistantText(current: string, next: string) {
  if (!current) {
    return next;
  }
  if (next.startsWith(current)) {
    return next;
  }
  if (current.endsWith(next)) {
    return current;
  }
  return current + next;
}

function toTaskEvent(event: StreamEvent): TaskEvent | null {
  if (event.event === "office.session") {
    return makeTaskEvent("Session 已连接", pickDetail(event.data, "sessionId") ?? undefined);
  }
  if (event.event.includes("tool.started")) {
    return makeTaskEvent("工具开始执行", pickDetail(event.data, "name") ?? stringifyEventData(event.data));
  }
  if (event.event.includes("tool.completed")) {
    return makeTaskEvent("工具完成", pickDetail(event.data, "name") ?? stringifyEventData(event.data));
  }
  if (event.event.includes("approval")) {
    return makeTaskEvent("等待人工确认", stringifyEventData(event.data));
  }
  if (event.event.includes("run.completed") || event.event === "office.done") {
    return makeTaskEvent("运行结束", stringifyEventData(event.data));
  }
  if (event.event.includes("error")) {
    return makeTaskEvent("Hermes 错误", stringifyEventData(event.data));
  }
  return null;
}

function progressFromEvent(event: StreamEvent) {
  if (event.event === "office.session") {
    return 12;
  }
  if (event.event.includes("tool.started")) {
    return 36;
  }
  if (event.event.includes("tool.completed")) {
    return 64;
  }
  if (event.event.includes("assistant")) {
    return 76;
  }
  if (event.event.includes("run.completed") || event.event === "office.done") {
    return 96;
  }
  if (event.event.includes("error")) {
    return 100;
  }
  return 20;
}

function pickDetail(data: unknown, key: string) {
  if (!data || typeof data !== "object") {
    return null;
  }
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function stringifyEventData(data: unknown) {
  if (typeof data === "string") {
    return data.length > 160 ? `${data.slice(0, 160)}...` : data;
  }
  try {
    const text = JSON.stringify(data);
    return text.length > 160 ? `${text.slice(0, 160)}...` : text;
  } catch {
    return "event";
  }
}

function loadAgentConfigs(): AgentConfigOverrides {
  try {
    const raw = window.localStorage.getItem(agentConfigStorageKey);
    return raw ? (JSON.parse(raw) as AgentConfigOverrides) : {};
  } catch {
    return {};
  }
}

function persistAgentConfigs(configs: AgentConfigOverrides) {
  try {
    window.localStorage.setItem(agentConfigStorageKey, JSON.stringify(configs));
  } catch {
    // Local storage is optional; the current session still uses the edited config.
  }
}
