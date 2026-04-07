import type { TaskData } from "../api/client.js";

export class TaskBoard {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private closeBtn: HTMLElement;
  private detailOverlay: HTMLElement;
  private detailTitle: HTMLElement;
  private detailContent: HTMLElement;
  private tasks: TaskData[] = [];

  constructor() {
    this.el = document.getElementById("task-board")!;
    this.listEl = document.getElementById("task-list")!;
    this.toggleBtn = document.getElementById("btn-tasks")!;
    this.closeBtn = document.getElementById("close-tasks")!;
    this.detailOverlay = document.getElementById("task-detail-overlay")!;
    this.detailTitle = document.getElementById("task-detail-title")!;
    this.detailContent = document.getElementById("task-detail-content")!;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());

    // Close detail modal
    document.getElementById("close-task-detail")!.addEventListener("click", () => this.closeDetail());
    this.detailOverlay.addEventListener("click", (e) => {
      if (e.target === this.detailOverlay) this.closeDetail();
    });

    // Keyboard shortcut
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        this.closeDetail();
      }
      if (e.key === "t" || e.key === "T") {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA") {
          this.toggle();
        }
      }
    });
  }

  toggle(): void {
    this.el.classList.toggle("open");
  }

  close(): void {
    this.el.classList.remove("open");
  }

  updateTasks(tasks: TaskData[]): void {
    this.tasks = tasks;

    const grouped = {
      in_progress: tasks.filter((t) => t.status === "in_progress" || t.status === "checkpoint"),
      pending: tasks.filter((t) => t.status === "pending" || t.status === "assigned"),
      completed: tasks.filter((t) => t.status === "completed").slice(0, 5),
      failed: tasks.filter((t) => t.status === "failed").slice(0, 3),
    };

    let html = "";

    if (grouped.in_progress.length > 0) {
      html += `<h3 style="color:#faa61a;font-size:13px;margin:8px 0 4px">In Progress (${grouped.in_progress.length})</h3>`;
      html += grouped.in_progress.map((t) => this.renderCard(t)).join("");
    }

    if (grouped.pending.length > 0) {
      html += `<h3 style="color:#99aab5;font-size:13px;margin:8px 0 4px">Pending (${grouped.pending.length})</h3>`;
      html += grouped.pending.map((t) => this.renderCard(t)).join("");
    }

    if (grouped.completed.length > 0) {
      html += `<h3 style="color:#57f287;font-size:13px;margin:8px 0 4px">Completed</h3>`;
      html += grouped.completed.map((t) => this.renderCard(t)).join("");
    }

    if (grouped.failed.length > 0) {
      html += `<h3 style="color:#ed4245;font-size:13px;margin:8px 0 4px">Failed</h3>`;
      html += grouped.failed.map((t) => this.renderCard(t)).join("");
    }

    if (tasks.length === 0) {
      html = '<div style="color:#666;text-align:center;padding:40px 0">No tasks yet</div>';
    }

    this.listEl.innerHTML = html;

    // Attach click listeners to task cards
    this.listEl.querySelectorAll<HTMLElement>(".task-card[data-task-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const taskId = card.dataset.taskId;
        const task = this.tasks.find((t) => t.id === taskId);
        if (task) this.showDetail(task);
      });
    });
  }

  private showDetail(task: TaskData): void {
    const riskColors: Record<string, string> = { GREEN: "#57f287", YELLOW: "#fee75c", RED: "#ed4245" };
    const statusColors: Record<string, string> = {
      in_progress: "#faa61a", checkpoint: "#faa61a", completed: "#57f287",
      failed: "#ed4245", pending: "#99aab5", assigned: "#5865f2",
    };

    const steps = task.steps || [];
    const doneSteps = task.status === "completed" && steps.length > 0
      ? steps.length
      : steps.filter((s) => s.status === "completed" || s.status === "skipped").length;
    const totalSteps = steps.length;
    const progressPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

    const fmt = (iso: string) => iso ? new Date(iso).toLocaleString() : "—";

    this.detailTitle.textContent = task.title;

    let html = "";

    // Status badge
    html += `<div class="field">
      <span class="label">Status</span>
      <span class="val" style="color:${statusColors[task.status] || "#999"}">${task.status.replace("_", " ").toUpperCase()}</span>
    </div>`;

    html += `<div class="field"><span class="label">Priority</span><span class="val">${task.priority}</span></div>`;
    html += `<div class="field"><span class="label">Risk Level</span><span class="val" style="color:${riskColors[task.risk_level] || "#999"}">${task.risk_level}</span></div>`;
    html += `<div class="field"><span class="label">Assigned To</span><span class="val">${task.assigned_to || "—"}</span></div>`;
    html += `<div class="field"><span class="label">Created By</span><span class="val">${task.created_by}</span></div>`;
    html += `<div class="field"><span class="label">Created At</span><span class="val">${fmt(task.created_at)}</span></div>`;
    html += `<div class="field"><span class="label">Updated At</span><span class="val">${fmt(task.updated_at)}</span></div>`;
    html += `<div class="field"><span class="label">Task ID</span><span class="val" style="font-size:10px;color:#666">${task.id}</span></div>`;

    if (task.description) {
      html += `<div class="section-title">Description</div>`;
      html += `<div class="description-box">${this.escapeHtml(task.description)}</div>`;
    }

    if (task.context_summary) {
      html += `<div class="section-title">Context Summary</div>`;
      html += `<div class="description-box">${this.escapeHtml(task.context_summary)}</div>`;
    }

    if (totalSteps > 0) {
      html += `<div class="section-title">Steps (${doneSteps}/${totalSteps} — ${progressPct}%)</div>`;
      html += `<div class="progress"><div class="progress-fill" style="width:${progressPct}%"></div></div>`;
      for (const step of steps) {
        html += `<div class="step-row">
          <span class="step-idx">#${step.step_index + 1}</span>
          <span class="step-desc">${this.escapeHtml(step.description)}</span>
          <span class="step-status ${step.status}">${step.status}</span>
        </div>`;
      }
    }

    this.detailContent.innerHTML = html;
    this.detailOverlay.classList.add("open");
  }

  private closeDetail(): void {
    this.detailOverlay.classList.remove("open");
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private renderCard(task: TaskData): string {
    const steps = task.steps || [];
    const doneSteps = task.status === "completed" && steps.length > 0
      ? steps.length
      : steps.filter((s: any) => s.status === "completed" || s.status === "skipped").length;
    const totalSteps = steps.length;
    const progressPct = totalSteps > 0 ? (doneSteps / totalSteps) * 100 : 0;

    const riskColors: Record<string, string> = { GREEN: "#57f287", YELLOW: "#fee75c", RED: "#ed4245" };
    const prioIcons: Record<string, string> = { urgent: "!!", high: "!", normal: "", low: "" };

    return `
      <div class="task-card ${task.status}" data-task-id="${task.id}" style="cursor:pointer" title="Click to view details">
        <div class="title">${prioIcons[task.priority] || ""}${task.title}</div>
        <div class="meta">
          <span style="color:${riskColors[task.risk_level] || "#999"}">${task.risk_level}</span>
          ${task.assigned_to ? ` · ${task.assigned_to}` : ""}
          ${totalSteps > 0 ? ` · Step ${doneSteps}/${totalSteps}` : ""}
        </div>
        ${totalSteps > 0 ? `<div class="progress"><div class="progress-fill" style="width:${progressPct}%"></div></div>` : ""}
      </div>`;
  }
}
