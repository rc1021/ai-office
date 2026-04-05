import type { AgentData } from "../api/client.js";

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

  show(agent: AgentData): void {
    const statusColors: Record<string, string> = {
      online: "#57f287", idle: "#57f287", busy: "#faa61a", offline: "#99aab5",
    };
    const statusColor = statusColors[agent.status] || "#999";

    this.detailsEl.innerHTML = `
      <div class="field"><span class="label">Agent ID:</span> ${agent.agent_id}</div>
      <div class="field"><span class="label">Role:</span> ${agent.role_id}</div>
      <div class="field"><span class="label">Department:</span> ${agent.department}</div>
      <div class="field"><span class="label">Clearance:</span> Level ${agent.clearance_level}</div>
      <div class="field">
        <span class="label">Status:</span>
        <span style="color:${statusColor};font-weight:bold"> ${agent.status.toUpperCase()}</span>
      </div>
      <div class="field"><span class="label">Last Heartbeat:</span><br>${agent.last_heartbeat}</div>
      <div class="field"><span class="label">Registered:</span><br>${agent.registered_at}</div>
      ${agent.current_task_id ? `<div class="field"><span class="label">Current Task:</span><br>${agent.current_task_id}</div>` : ""}
    `;

    this.el.classList.add("open");
  }

  close(): void {
    this.el.classList.remove("open");
  }
}
