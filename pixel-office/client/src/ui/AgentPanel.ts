import type { AgentData, TaskData } from "../api/client.js";

const STATUS_COLORS: Record<string, string> = {
  online: "#57f287", idle: "#57f287", busy: "#faa61a", offline: "#99aab5",
};

const CLEARANCE_LABELS: Record<number, string> = {
  0: "PUBLIC", 1: "INTERNAL", 2: "CONFIDENTIAL", 3: "RESTRICTED",
};

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp + (timestamp.includes("Z") ? "" : "Z")).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export class AgentPanel {
  private el: HTMLElement;
  private detailsEl: HTMLElement;
  private closeBtn: HTMLElement;

  constructor() {
    this.el = document.getElementById("agent-panel")!;
    this.detailsEl = document.getElementById("agent-details")!;
    this.closeBtn = document.getElementById("close-agent")!;

    this.closeBtn.addEventListener("click", () => this.close());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.close();
    });
  }

  show(agent: AgentData, tasks: TaskData[] = []): void {
    const statusColor = STATUS_COLORS[agent.status] || "#999";
    const clearanceLabel = CLEARANCE_LABELS[agent.clearance_level] ?? `Level ${agent.clearance_level}`;

    // Find tasks assigned to this agent
    const agentTasks = tasks.filter(
      (t) => t.assigned_to === agent.agent_id || t.assigned_to === agent.role_id
    );
    const activeTasks = agentTasks.filter(
      (t) => ["in_progress", "checkpoint", "assigned"].includes(t.status)
    );
    const completedCount = agentTasks.filter((t) => t.status === "completed").length;

    let html = `
      <div class="agent-header">
        <div class="agent-status-badge" style="background:${statusColor}">${agent.status.toUpperCase()}</div>
      </div>
      <div class="field"><span class="label">Agent ID</span><span class="val">${agent.agent_id}</span></div>
      <div class="field"><span class="label">Role</span><span class="val">${agent.role_id}</span></div>
      <div class="field"><span class="label">Department</span><span class="val">${agent.department}</span></div>
      <div class="field"><span class="label">Clearance</span><span class="val">${clearanceLabel}</span></div>
      <div class="field"><span class="label">Heartbeat</span><span class="val">${timeAgo(agent.last_heartbeat)}</span></div>
      <div class="field"><span class="label">Registered</span><span class="val">${timeAgo(agent.registered_at)}</span></div>
    `;

    // Active tasks section
    if (activeTasks.length > 0) {
      html += `<h3 class="section-title" style="color:#faa61a">Active Tasks</h3>`;
      for (const task of activeTasks) {
        const steps = task.steps || [];
        const done = steps.filter((s: any) => s.status === "completed").length;
        const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;
        html += `
          <div class="agent-task-card">
            <div class="task-title">${task.title}</div>
            <div class="task-meta">${task.risk_level} · Step ${done}/${steps.length}</div>
            <div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
          </div>
        `;
      }
    }

    // Stats
    html += `
      <h3 class="section-title" style="color:#57f287">Stats</h3>
      <div class="field"><span class="label">Completed</span><span class="val">${completedCount} tasks</span></div>
      <div class="field"><span class="label">Active</span><span class="val">${activeTasks.length} tasks</span></div>
    `;

    this.detailsEl.innerHTML = html;
    this.el.classList.add("open");
  }

  close(): void {
    this.el.classList.remove("open");
  }
}
