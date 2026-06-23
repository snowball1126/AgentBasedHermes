import { AlertTriangle, Check, Clock, Loader2, Wifi, WifiOff } from "lucide-react";
import type { AgentProfile, AgentStatus } from "../data/agents";

type OfficeSceneProps = {
  agents: AgentProfile[];
  statuses: Record<string, AgentStatus>;
  activeAgentId: string;
  activeTasksByAgent: Record<string, string | undefined>;
  onSelectAgent: (agentId: string) => void;
};

const statusIcons = {
  online: Wifi,
  busy: Loader2,
  blocked: AlertTriangle,
  done: Check,
  offline: WifiOff
};

const statusText = {
  online: "在线",
  busy: "忙碌",
  blocked: "阻塞",
  done: "完成",
  offline: "离线"
};

const deskStatusText = {
  online: "在线待命",
  busy: "正在执行任务",
  blocked: "等待处理",
  done: "刚完成任务",
  offline: "离线"
};

export function OfficeScene({
  agents,
  statuses,
  activeAgentId,
  activeTasksByAgent,
  onSelectAgent
}: OfficeSceneProps) {
  return (
    <main className="office-stage" aria-label="Hermes Agent office">
      <div className="office-title">
        <div>
          <span className="office-kicker">Hermes PM + Codex Workers</span>
          <h1>Agent办公室</h1>
        </div>
        <div className="office-clock">
          <Clock size={16} />
          <span>实时工位</span>
        </div>
      </div>

      <div className="office-map">
        <div className="floor-lane floor-lane-vertical" />
        <div className="floor-lane floor-lane-horizontal" />

        <div className="wall-zone wall-zone-top">
          <div className="shelf">
            {Array.from({ length: 9 }).map((_, index) => (
              <span key={index} />
            ))}
          </div>
          <div className="cabinet" />
        </div>

        <div className="lounge-zone">
          <div className="treadmill" />
          <div className="bench" />
        </div>

        <div className="meeting-zone">
          <div className="meeting-table" />
          <span>Search Bay</span>
        </div>

        <div className="empty-workstation empty-workstation-top">
          <span className="mini-monitor" />
          <span className="mini-desk" />
          <small>待分配工位</small>
        </div>

        <div className="office-notice">
          <strong>Hermes</strong>
          <span>负责记忆、PM、日常对话</span>
        </div>

        {agents.map((agent) => {
          const status = statuses[agent.id] ?? "offline";
          const Icon = statusIcons[status];
          const isActive = activeAgentId === agent.id;
          const isHermes = agent.runtime === "hermes-core";
          return (
            <button
              type="button"
              key={agent.id}
              className={`agent-desk agent-${agent.id} status-${status} is-${agent.runtime} ${isActive ? "is-active" : ""}`}
              style={
                {
                  left: `${agent.desk.x}%`,
                  top: `${agent.desk.y}%`,
                  "--agent-accent": agent.accent,
                  "--agent-suit": agent.suit
                } as React.CSSProperties
              }
              onClick={() => onSelectAgent(agent.id)}
              aria-label={`${agent.name}, ${statusText[status]}`}
            >
              <span className="desk-mission">{isHermes ? "PM / Memory" : "Codex Worker"}</span>
              <span className="status-chip">
                <Icon size={13} />
                <span>{statusText[status]}</span>
              </span>
              <span className="desk-surface">
                <span className="monitor" />
                <span className="keyboard" />
                <span className="desk-shadow-leg desk-shadow-left" />
                <span className="desk-shadow-leg desk-shadow-right" />
                <span className="chair" />
                <span className="agent-person" aria-hidden="true">
                  <span className="agent-head" />
                  <span className="agent-body" />
                  <span className="agent-arm agent-arm-left" />
                  <span className="agent-arm agent-arm-right" />
                </span>
              </span>
              <span className="agent-label">
                <strong>{agent.name}</strong>
                <small>{activeTasksByAgent[agent.id] ?? deskStatusText[status]}</small>
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
