import {
  BookOpen,
  Bot,
  CheckCircle2,
  Database,
  FileText,
  Loader2,
  MessageSquare,
  Send,
  ShieldCheck,
  Sparkles,
  Wrench,
  X
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import type { AgentProfile, AgentStatus } from "../data/agents";
import type { HermesSkill, HermesToolset } from "../lib/hermesClient";
import type { ChatMessage, TaskEvent, TaskItem } from "../types";

type AgentDrawerProps = {
  agent: AgentProfile;
  status: AgentStatus;
  open: boolean;
  messages: ChatMessage[];
  tasks: TaskItem[];
  skills: HermesSkill[];
  toolsets: HermesToolset[];
  connectionOk: boolean;
  onClose: () => void;
  onSend: (agentId: string, message: string) => Promise<void>;
  onSaveConfig: (agentId: string, markdown: string) => void;
  onResetConfig: (agentId: string) => void;
};

type TabKey = "config" | "skills" | "memory" | "chat";

const tabs: Array<{ key: TabKey; label: string; icon: typeof FileText }> = [
  { key: "config", label: "配置文档", icon: FileText },
  { key: "skills", label: "技能列表", icon: Wrench },
  { key: "memory", label: "工作记录", icon: Database },
  { key: "chat", label: "即时交互", icon: MessageSquare }
];

export function AgentDrawer({
  agent,
  status,
  open,
  messages,
  tasks,
  skills,
  toolsets,
  connectionOk,
  onClose,
  onSend,
  onSaveConfig,
  onResetConfig
}: AgentDrawerProps) {
  const [activeTab, setActiveTab] = useState<TabKey>("chat");
  const [input, setInput] = useState("");
  const agentTasks = useMemo(() => tasks.filter((task) => task.agentId === agent.id), [agent.id, tasks]);
  const activeTask = agentTasks.find((task) => task.status === "running") ?? agentTasks[0];

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = input.trim();
    if (!value) {
      return;
    }
    setInput("");
    setActiveTab("chat");
    await onSend(agent.id, value);
  }

  if (!open) {
    return null;
  }

  return (
    <aside className="agent-drawer" aria-label={`${agent.name} details`}>
      <div className="drawer-top">
        <div className="drawer-avatar" style={{ "--agent-accent": agent.accent } as React.CSSProperties}>
          <Bot size={22} />
        </div>
        <div>
          <span className="eyebrow">{agent.sessionKey}</span>
          <h2>{agent.name}</h2>
          <p>{agent.role}</p>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close agent details">
          <X size={18} />
        </button>
      </div>

      <div className={`drawer-status status-${status}`}>
        <ShieldCheck size={16} />
        <span>{connectionOk ? `${agent.routing} · ${status}` : "Hermes gateway offline"}</span>
      </div>

      <nav className="drawer-tabs" aria-label="Agent detail sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              type="button"
              key={tab.key}
              className={activeTab === tab.key ? "is-active" : ""}
              onClick={() => setActiveTab(tab.key)}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="drawer-body">
        {activeTab === "config" ? (
          <ConfigPanel
            agentId={agent.id}
            markdown={agent.configMarkdown}
            onSave={onSaveConfig}
            onReset={onResetConfig}
          />
        ) : null}
        {activeTab === "skills" ? (
          <SkillsPanel agent={agent} skills={skills} toolsets={toolsets} connectionOk={connectionOk} />
        ) : null}
        {activeTab === "memory" ? <MemoryPanel agent={agent} tasks={agentTasks} activeTask={activeTask} /> : null}
        {activeTab === "chat" ? (
          <ChatPanel
            agent={agent}
            status={status}
            messages={messages}
            activeTask={activeTask}
            input={input}
            setInput={setInput}
            onSubmit={handleSubmit}
            connectionOk={connectionOk}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ConfigPanel({
  agentId,
  markdown,
  onSave,
  onReset
}: {
  agentId: string;
  markdown: string;
  onSave: (agentId: string, markdown: string) => void;
  onReset: (agentId: string) => void;
}) {
  const [draft, setDraft] = useState(markdown);

  useEffect(() => {
    setDraft(markdown);
  }, [markdown]);

  return (
    <section className="drawer-section">
      <div className="section-title">
        <BookOpen size={16} />
        <span>本地角色配置</span>
      </div>
      <textarea
        className="config-editor"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        rows={16}
        spellCheck={false}
      />
      <div className="config-actions">
        <button type="button" onClick={() => onSave(agentId, draft)}>
          保存配置
        </button>
        <button type="button" onClick={() => onReset(agentId)}>
          恢复默认
        </button>
      </div>
    </section>
  );
}

function SkillsPanel({
  agent,
  skills,
  toolsets,
  connectionOk
}: {
  agent: AgentProfile;
  skills: HermesSkill[];
  toolsets: HermesToolset[];
  connectionOk: boolean;
}) {
  return (
    <section className="drawer-section">
      <div className="section-title">
        <Sparkles size={16} />
        <span>{connectionOk ? "Hermes 实时技能" : "本地备用技能"}</span>
      </div>

      <div className="skill-grid">
        {(connectionOk && skills.length ? skills.slice(0, 12).map((skill) => skill.name) : agent.fallbackSkills).map(
          (skill) => (
            <span key={skill}>{skill}</span>
          )
        )}
      </div>

      <div className="toolset-list">
        {(toolsets.length ? toolsets.slice(0, 6) : []).map((toolset) => (
          <article key={toolset.name}>
            <strong>{toolset.label ?? toolset.name}</strong>
            <span>{toolset.configured === false ? "未配置" : toolset.enabled === false ? "未启用" : "可用"}</span>
            <small>{formatTools(toolset.tools) || toolset.description || "Hermes toolset"}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatTools(tools: HermesToolset["tools"]) {
  if (Array.isArray(tools)) {
    return tools.slice(0, 6).join(", ");
  }
  if (typeof tools === "string") {
    return tools.split(/\s+/).filter(Boolean).slice(0, 6).join(", ");
  }
  return "";
}

function MemoryPanel({
  agent,
  tasks,
  activeTask
}: {
  agent: AgentProfile;
  tasks: TaskItem[];
  activeTask?: TaskItem;
}) {
  return (
    <section className="drawer-section">
      <div className="section-title">
        <Database size={16} />
        <span>记忆库与工作记录</span>
      </div>

      <div className="memory-list">
        {agent.memories.map((memory) => (
          <article key={memory.title}>
            <span>{memory.type}</span>
            <strong>{memory.title}</strong>
            <p>{memory.content}</p>
          </article>
        ))}
      </div>

      {activeTask ? <TaskTimeline events={activeTask.events} /> : null}

      <div className="history-list">
        {tasks.length ? (
          tasks.map((task) => (
            <article key={task.id}>
              <CheckCircle2 size={15} />
              <div>
                <strong>{task.title}</strong>
                <span>{task.result || task.status}</span>
              </div>
            </article>
          ))
        ) : (
          <p className="muted">还没有工作记录。</p>
        )}
      </div>
    </section>
  );
}

function ChatPanel({
  agent,
  status,
  messages,
  activeTask,
  input,
  setInput,
  onSubmit,
  connectionOk
}: {
  agent: AgentProfile;
  status: AgentStatus;
  messages: ChatMessage[];
  activeTask?: TaskItem;
  input: string;
  setInput: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  connectionOk: boolean;
}) {
  return (
    <section className="chat-panel">
      <div className="message-list" aria-live="polite">
        {messages.length === 0 ? (
          <div className="empty-chat">
            <MessageSquare size={28} />
            <strong>直接给 {agent.name} 下达指令</strong>
            <span>发送后会创建 Hermes session，并在右侧任务台账里实时追踪。</span>
          </div>
        ) : (
          messages.map((message) => (
            <article key={message.id} className={`message-bubble ${message.role}`}>
              <span>{message.role === "user" ? "你" : agent.name}</span>
              <p>{message.content || "正在接收 Hermes 流式响应..."}</p>
            </article>
          ))
        )}
      </div>

      {activeTask ? <TaskTimeline events={activeTask.events} compact /> : null}

      <form className="chat-input" onSubmit={onSubmit}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            connectionOk
              ? `向 ${agent.name} 下达任务...`
              : "Hermes gateway 未连接。请先启动 hermes gateway 并配置 .env。"
          }
          rows={3}
          disabled={!connectionOk || status === "busy"}
        />
        <button type="submit" disabled={!connectionOk || status === "busy" || input.trim().length === 0}>
          {status === "busy" ? <Loader2 size={17} /> : <Send size={17} />}
          <span>{status === "busy" ? "执行中" : "发送"}</span>
        </button>
      </form>
    </section>
  );
}

function TaskTimeline({ events, compact = false }: { events: TaskEvent[]; compact?: boolean }) {
  if (!events.length) {
    return null;
  }

  return (
    <div className={`task-timeline ${compact ? "is-compact" : ""}`}>
      {events.slice(-6).map((event) => (
        <div key={event.id}>
          <span>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(event.at))}</span>
          <strong>{event.label}</strong>
          {event.detail ? <small>{event.detail}</small> : null}
        </div>
      ))}
    </div>
  );
}
