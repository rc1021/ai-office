import { API_BASE } from "../config.js";

export interface AgentData {
  agent_id: string;
  role_id: string;
  department: string;
  status: string;
  current_task_id: string | null;
  clearance_level: number;
  last_heartbeat: string;
  registered_at: string;
}

export interface TaskStep {
  step_index: number;
  description: string;
  status: string;
  completed_at?: string;
  output_artifact?: string;
}

export interface TaskData {
  id: string;
  trace_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  risk_level: string;
  assigned_to: string | null;
  created_by: string;
  current_step: number;
  steps: TaskStep[];
  context_summary: string;
  created_at: string;
  updated_at: string;
}

export type SSEHandlers = {
  onAgents: (agents: AgentData[]) => void;
  onTasks: (tasks: TaskData[]) => void;
};

export class OfficeAPI {
  private eventSource: EventSource | null = null;

  async getAgents(): Promise<AgentData[]> {
    const res = await fetch(`${API_BASE}/agents`);
    return res.json();
  }

  async getTasks(): Promise<TaskData[]> {
    const res = await fetch(`${API_BASE}/tasks`);
    return res.json();
  }

  async getSummary(): Promise<any> {
    const res = await fetch(`${API_BASE}/summary`);
    return res.json();
  }

  subscribe(handlers: SSEHandlers): void {
    this.eventSource = new EventSource(`${API_BASE}/stream`);

    this.eventSource.addEventListener("agents", (e) => {
      handlers.onAgents(JSON.parse((e as MessageEvent).data));
    });

    this.eventSource.addEventListener("tasks", (e) => {
      handlers.onTasks(JSON.parse((e as MessageEvent).data));
    });

    this.eventSource.onerror = () => {
      console.warn("[API] SSE connection lost, reconnecting...");
    };
  }

  disconnect(): void {
    this.eventSource?.close();
    this.eventSource = null;
  }
}
