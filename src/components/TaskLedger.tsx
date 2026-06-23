import { Activity, CheckCircle2, Circle, Filter, FolderKanban, XCircle } from "lucide-react";
import type { CSSProperties } from "react";
import type { AgentProfile } from "../data/agents";
import type { TaskItem, TaskStatus } from "../types";

type TaskLedgerProps = {
  tasks: TaskItem[];
  agents: AgentProfile[];
  skillsCount: number;
  toolsetsCount: number;
  activeFilter: TaskStatus | "all";
  selectedTaskId: string | null;
  onFilterChange: (filter: TaskStatus | "all") => void;
  onSelectTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
};

const filterLabels: Record<TaskStatus | "all", string> = {
  all: "全部",
  running: "进行中",
  done: "已完成",
  blocked: "阻塞",
  queued: "等待"
};

export function TaskLedger({
  tasks,
  agents,
  skillsCount,
  toolsetsCount,
  activeFilter,
  selectedTaskId,
  onFilterChange,
  onSelectTask,
  onCompleteTask
}: TaskLedgerProps) {
  const filtered = activeFilter === "all" ? tasks : tasks.filter((task) => task.status === activeFilter);
  const running = tasks.filter((task) => task.status === "running").length;
  const done = tasks.filter((task) => task.status === "done").length;
  const blocked = tasks.filter((task) => task.status === "blocked").length;
  const workflowCount = new Set(tasks.map((task) => task.workflowId).filter(Boolean)).size;

  return (
    <aside className="task-ledger" aria-label="Global task ledger">
      <div className="ledger-header">
        <span className="eyebrow">全局任务台账</span>
        <h2>Hermes 提交队列</h2>
      </div>

      <div className="metric-strip">
        <div>
          <strong>{running}</strong>
          <span>进行中</span>
        </div>
        <div>
          <strong>{done}</strong>
          <span>已完成</span>
        </div>
        <div>
          <strong>{blocked}</strong>
          <span>阻塞</span>
        </div>
      </div>

      <div className="ledger-scope">
        <FolderKanban size={15} />
        <span>{workflowCount || 0} 个项目文件夹</span>
        <em>{skillsCount} skills · {toolsetsCount} toolsets</em>
      </div>

      <div className="ledger-filter" aria-label="Task filters">
        <Filter size={15} />
        {(Object.keys(filterLabels) as Array<TaskStatus | "all">).map((filter) => (
          <button
            type="button"
            key={filter}
            className={activeFilter === filter ? "is-active" : ""}
            onClick={() => onFilterChange(filter)}
          >
            {filterLabels[filter]}
          </button>
        ))}
      </div>

      <div className="ledger-list">
        {filtered.length === 0 ? (
          <StandbyLedger agents={agents} />
        ) : (
          filtered.map((task) => {
            const agent = agents.find((item) => item.id === task.agentId);
            return (
              <article
                key={task.id}
                className={`task-row status-${task.status} ${selectedTaskId === task.id ? "is-selected" : ""}`}
                onClick={() => onSelectTask(task.id)}
              >
                <button
                  type="button"
                  className="task-check"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCompleteTask(task.id);
                  }}
                  aria-label={`Mark ${task.title} complete`}
                >
                  {task.status === "done" ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                </button>
                <div className="task-agent-dot" style={{ "--agent-accent": agent?.accent } as CSSProperties} />
                <div className="task-main">
                  <div className="task-title-line">
                    <strong>{task.title}</strong>
                    {task.parentId ? <span className="dispatch-badge">Hermes 派发</span> : null}
                    {task.status === "blocked" ? <XCircle size={15} /> : null}
                  </div>
                  <span>{agent?.name ?? "Unknown Agent"}</span>
                  {task.projectPath ? <small className="task-path">{task.branchPath ?? task.projectPath}</small> : null}
                  <div className="progress-track">
                    <span style={{ width: `${task.progress}%` }} />
                  </div>
                </div>
                <div className="task-meta">
                  <span>{filterLabels[task.status]}</span>
                  <small>{formatTime(task.createdAt)}</small>
                </div>
              </article>
            );
          })
        )}
      </div>
    </aside>
  );
}

function StandbyLedger({ agents }: { agents: AgentProfile[] }) {
  return (
    <div className="standby-ledger">
      <div className="standby-head">
        <div>
          <Activity size={16} />
          <strong>办公室待命</strong>
        </div>
        <span>实时</span>
      </div>

      <div className="standby-rows">
        {agents.map((agent) => (
          <article key={agent.id} className={`standby-row is-${agent.runtime}`}>
            <span className="standby-avatar" style={{ "--agent-accent": agent.accent } as CSSProperties} />
            <div>
              <strong>{agent.name}</strong>
              <small>{agent.runtime === "hermes-core" ? "接单 / PM / 记忆 / 提交" : "Codex worker 分支"}</small>
            </div>
            <em>{agent.runtime === "hermes-core" ? "主控" : "待命"}</em>
          </article>
        ))}
      </div>
    </div>
  );
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
