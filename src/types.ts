export type TaskStatus = "queued" | "running" | "done" | "blocked";

export type TaskEvent = {
  id: string;
  at: string;
  label: string;
  detail?: string;
};

export type TaskItem = {
  id: string;
  title: string;
  agentId: string;
  parentId?: string;
  workflowId?: string;
  projectPath?: string;
  branchPath?: string;
  reportPath?: string;
  obsidianPath?: string;
  status: TaskStatus;
  progress: number;
  createdAt: string;
  completedAt?: string;
  events: TaskEvent[];
  result?: string;
};

export type ChatMessage = {
  id: string;
  agentId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};
