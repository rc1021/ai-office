import { API_BASE } from "../config.js";

export interface ActivityData {
  source: 'event' | 'audit';
  id: string;
  timestamp: string;
  agent_id: string;
  type: string;
  target: string;
  detail: string;
  trace_id: string;
}

const SOURCE_COLORS: Record<string, { bg: string; label: string }> = {
  event: { bg: '#5865f2', label: 'EVT' },
  audit: { bg: '#faa61a', label: 'AUD' },
};

const TYPE_COLORS: Record<string, string> = {
  'task.created': '#5865f2',
  'task.completed': '#57f287',
  'task.failed': '#ed4245',
  'task.checkpoint': '#faa61a',
  'task.assigned': '#5865f2',
  'agent.online': '#57f287',
  'agent.offline': '#99aab5',
  'artifact.published': '#9b59b6',
  'anomaly.reported': '#ed4245',
  'report_status': '#57f287',
  'task_create': '#5865f2',
  'task_update': '#faa61a',
  'check_inbox': '#99aab5',
  'publish_event': '#9b59b6',
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
  const parts = type.split(".");
  return parts.length > 1 ? parts.slice(1).join(".") : type;
}

export class ActivityLog {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private closeBtn: HTMLElement;
  private filterAgent: HTMLSelectElement;
  private filterType: HTMLSelectElement;
  private allActivity: ActivityData[] = [];

  constructor() {
    this.el = document.getElementById("activity-log")!;
    this.listEl = document.getElementById("activity-list")!;
    this.toggleBtn = document.getElementById("btn-activity")!;
    this.closeBtn = document.getElementById("close-activity")!;
    this.filterAgent = document.getElementById("filter-activity-agent") as HTMLSelectElement;
    this.filterType = document.getElementById("filter-activity-type") as HTMLSelectElement;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());
    this.filterAgent.addEventListener("change", () => this.render());
    this.filterType.addEventListener("change", () => this.render());

    document.addEventListener("keydown", (e) => {
      if (e.key === "a" || e.key === "A") {
        const target = e.target as HTMLElement;
        if (
          target.tagName !== "INPUT" &&
          target.tagName !== "TEXTAREA" &&
          target.tagName !== "SELECT"
        ) {
          this.toggle();
        }
      }
    });
  }

  toggle(): void { this.el.classList.toggle("open"); }
  close(): void { this.el.classList.remove("open"); }

  updateActivity(items: ActivityData[]): void {
    this.allActivity = items;
    this.updateFilters();
    this.render();
  }

  private updateFilters(): void {
    const agents = [...new Set(this.allActivity.map((a) => a.agent_id).filter(Boolean))].sort();
    const types = [...new Set(this.allActivity.map((a) => a.type).filter(Boolean))].sort();

    const currentAgent = this.filterAgent.value;
    const currentType = this.filterType.value;

    this.filterAgent.innerHTML =
      `<option value="">All Agents</option>` +
      agents
        .map(
          (a) =>
            `<option value="${this.escapeHtml(a)}"${a === currentAgent ? " selected" : ""}>${this.escapeHtml(shortAgent(a))}</option>`
        )
        .join("");

    this.filterType.innerHTML =
      `<option value="">All Types</option>` +
      types
        .map(
          (t) =>
            `<option value="${this.escapeHtml(t)}"${t === currentType ? " selected" : ""}>${this.escapeHtml(t)}</option>`
        )
        .join("");
  }

  private render(): void {
    const agent = this.filterAgent.value;
    const type = this.filterType.value;

    let filtered = this.allActivity;
    if (agent) filtered = filtered.filter((a) => a.agent_id === agent);
    if (type) filtered = filtered.filter((a) => a.type === type);

    // Newest first (already sorted by backend, but ensure it)
    const sorted = [...filtered].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (sorted.length === 0) {
      this.listEl.innerHTML =
        '<div style="color:#666;text-align:center;padding:20px 0">No activity</div>';
      return;
    }

    this.listEl.innerHTML = sorted.map((a) => this.renderRow(a)).join("");

    // Attach click handlers for expand/collapse
    this.listEl.querySelectorAll<HTMLElement>(".activity-row").forEach((row) => {
      row.addEventListener("click", () => {
        row.classList.toggle("expanded");
      });
    });
  }

  private renderRow(item: ActivityData): string {
    const sourceInfo = SOURCE_COLORS[item.source] ?? { bg: '#99aab5', label: item.source.toUpperCase() };
    const typeColor = TYPE_COLORS[item.type] ?? '#99aab5';
    const preview =
      item.detail && item.detail.length > 120
        ? item.detail.substring(0, 120) + "..."
        : item.detail ?? "";

    // Pretty-print JSON detail if parseable
    let prettyDetail: string;
    try {
      const parsed = JSON.parse(item.detail);
      prettyDetail = JSON.stringify(parsed, null, 2);
    } catch {
      prettyDetail = item.detail ?? "";
    }

    const targetHtml = item.target
      ? `<span class="activity-target">→ ${this.escapeHtml(item.target)}</span>`
      : "";

    return `
      <div class="activity-row">
        <div class="activity-header">
          <span class="activity-time">${timeAgo(item.timestamp)}</span>
          <span class="activity-source" style="background:${sourceInfo.bg}">${sourceInfo.label}</span>
          <span class="activity-agent">${this.escapeHtml(shortAgent(item.agent_id || ""))}</span>
          <span class="activity-type" style="background:${typeColor}">${this.escapeHtml(shortType(item.type))}</span>
          ${targetHtml}
        </div>
        <div class="activity-preview">${this.escapeHtml(preview)}</div>
        <div class="activity-detail">
          <pre>${this.escapeHtml(prettyDetail)}</pre>
          <div class="detail-meta">
            trace: ${this.escapeHtml(item.trace_id || "—")} &nbsp;|&nbsp;
            ${this.escapeHtml(item.timestamp)}
          </div>
        </div>
      </div>`;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}
