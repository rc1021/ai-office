import type { EventData } from "../api/client.js";

const TYPE_COLORS: Record<string, string> = {
  "task.created": "#5865f2",
  "task.completed": "#57f287",
  "task.failed": "#ed4245",
  "task.checkpoint": "#faa61a",
  "task.assigned": "#5865f2",
  "agent.online": "#57f287",
  "agent.offline": "#99aab5",
  "artifact.published": "#9b59b6",
  "anomaly.reported": "#ed4245",
  "verification.failed": "#ed4245",
  "brainstorm.perspective": "#3498db",
  "brainstorm.response": "#2ecc71",
};

function timeAgo(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp + (timestamp.includes("Z") ? "" : "Z")).getTime();
  const diff = Math.floor((now - then) / 1000);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function shortAgent(agentId: string): string {
  const parts = agentId.split("-");
  if (parts.length === 1) return agentId.substring(0, 6);
  const initials = parts.slice(0, -1).map((p) => p[0].toUpperCase()).join("");
  const num = parts[parts.length - 1];
  return /^\d+$/.test(num) ? `${initials}-${num}` : agentId.substring(0, 8);
}

function shortType(type: string): string {
  // "task.completed" → "completed", "agent.online" → "online"
  const parts = type.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : type;
}

export class MessageFeed {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private closeBtn: HTMLElement;
  private filterAgent: HTMLSelectElement;
  private filterType: HTMLSelectElement;
  private allEvents: EventData[] = [];

  constructor() {
    this.el = document.getElementById("message-feed")!;
    this.listEl = document.getElementById("event-list")!;
    this.toggleBtn = document.getElementById("btn-messages")!;
    this.closeBtn = document.getElementById("close-messages")!;
    this.filterAgent = document.getElementById("filter-agent") as HTMLSelectElement;
    this.filterType = document.getElementById("filter-type") as HTMLSelectElement;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());
    this.filterAgent.addEventListener("change", () => this.render());
    this.filterType.addEventListener("change", () => this.render());

    document.addEventListener("keydown", (e) => {
      if (e.key === "m" || e.key === "M") {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && target.tagName !== "SELECT") {
          this.toggle();
        }
      }
    });
  }

  toggle(): void { this.el.classList.toggle("open"); }
  close(): void { this.el.classList.remove("open"); }

  updateEvents(events: EventData[]): void {
    this.allEvents = events;
    this.updateFilters();
    this.render();
  }

  private updateFilters(): void {
    const agents = [...new Set(this.allEvents.map((e) => e.source_agent))].sort();
    const types = [...new Set(this.allEvents.map((e) => e.type))].sort();

    const currentAgent = this.filterAgent.value;
    const currentType = this.filterType.value;

    this.filterAgent.innerHTML = `<option value="">All Agents</option>` +
      agents.map((a) => `<option value="${a}"${a === currentAgent ? " selected" : ""}>${shortAgent(a)}</option>`).join("");

    this.filterType.innerHTML = `<option value="">All Types</option>` +
      types.map((t) => `<option value="${t}"${t === currentType ? " selected" : ""}>${t}</option>`).join("");
  }

  private render(): void {
    const agent = this.filterAgent.value;
    const type = this.filterType.value;

    let filtered = this.allEvents;
    if (agent) filtered = filtered.filter((e) => e.source_agent === agent);
    if (type) filtered = filtered.filter((e) => e.type === type);

    // Newest first
    const sorted = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));

    if (sorted.length === 0) {
      this.listEl.innerHTML = '<div style="color:#666;text-align:center;padding:20px 0">No events</div>';
      return;
    }

    this.listEl.innerHTML = sorted.map((e) => this.renderEvent(e)).join("");
  }

  private renderEvent(event: EventData): string {
    const color = TYPE_COLORS[event.type] ?? "#99aab5";
    const payloadStr = JSON.stringify(event.payload);
    const preview = payloadStr.length > 120 ? payloadStr.substring(0, 120) + "..." : payloadStr;

    return `
      <div class="event-card">
        <div class="event-header">
          <span class="event-time">${timeAgo(event.created_at)}</span>
          <span class="event-agent">${shortAgent(event.source_agent)}</span>
          <span class="event-type" style="background:${color}">${shortType(event.type)}</span>
          <span class="event-target">→ ${event.target_agents === "*" ? "all" : shortAgent(event.target_agents)}</span>
        </div>
        <div class="event-payload">${this.escapeHtml(preview)}</div>
      </div>`;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
