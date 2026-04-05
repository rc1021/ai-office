import type { TaskData } from "../api/client.js";

export class TaskBoard {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private toggleBtn: HTMLElement;
  private closeBtn: HTMLElement;

  constructor() {
    this.el = document.getElementById("task-board")!;
    this.listEl = document.getElementById("task-list")!;
    this.toggleBtn = document.getElementById("btn-tasks")!;
    this.closeBtn = document.getElementById("close-tasks")!;

    this.toggleBtn.addEventListener("click", () => this.toggle());
    this.closeBtn.addEventListener("click", () => this.close());

    // Keyboard shortcut
    document.addEventListener("keydown", (e) => {
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
  }

  private renderCard(task: TaskData): string {
    const steps = task.steps || [];
    const completedSteps = steps.filter((s: any) => s.status === "completed").length;
    const totalSteps = steps.length;
    const progressPct = totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0;

    const riskColors: Record<string, string> = { GREEN: "#57f287", YELLOW: "#fee75c", RED: "#ed4245" };
    const prioIcons: Record<string, string> = { urgent: "!!", high: "!", normal: "", low: "" };

    return `
      <div class="task-card ${task.status}">
        <div class="title">${prioIcons[task.priority] || ""}${task.title}</div>
        <div class="meta">
          <span style="color:${riskColors[task.risk_level] || "#999"}">${task.risk_level}</span>
          ${task.assigned_to ? ` · ${task.assigned_to}` : ""}
          ${totalSteps > 0 ? ` · Step ${completedSteps}/${totalSteps}` : ""}
        </div>
        ${totalSteps > 0 ? `<div class="progress"><div class="progress-fill" style="width:${progressPct}%"></div></div>` : ""}
      </div>`;
  }
}
