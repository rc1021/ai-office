/**
 * BrainstormPanel — Shows brainstorming sessions grouped by trace_id
 * Toggle with 'B' key
 */

interface BrainstormEvent {
  type: string;
  source_agent: string;
  payload: Record<string, unknown>;
  trace_id: string;
  created_at: string;
}

export class BrainstormPanel {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private sessions: Map<string, BrainstormEvent[]> = new Map();

  constructor() {
    this.el = document.getElementById("brainstorm-panel")!;
    this.listEl = document.getElementById("brainstorm-list")!;

    document.getElementById("btn-brainstorm")?.addEventListener("click", () => this.toggle());
    document.getElementById("close-brainstorm")?.addEventListener("click", () => this.hide());

    document.addEventListener("keydown", (e) => {
      if (e.key === "b" || e.key === "B") {
        if (document.activeElement?.tagName !== "INPUT") this.toggle();
      }
    });
  }

  toggle(): void {
    this.el.classList.toggle("open");
  }

  hide(): void {
    this.el.classList.remove("open");
  }

  updateEvents(events: BrainstormEvent[]): void {
    // Filter for brainstorm events only
    const brainstormEvents = events.filter(e =>
      e.type === "brainstorm.perspective" || e.type === "brainstorm.response"
    );

    if (brainstormEvents.length === 0) {
      this.listEl.innerHTML = '<div style="color:#888;padding:12px;">No brainstorm sessions yet</div>';
      return;
    }

    // Group by trace_id
    this.sessions.clear();
    for (const evt of brainstormEvents) {
      if (!this.sessions.has(evt.trace_id)) {
        this.sessions.set(evt.trace_id, []);
      }
      this.sessions.get(evt.trace_id)!.push(evt);
    }

    // Render
    let html = "";
    for (const [traceId, evts] of this.sessions) {
      const perspectives = evts.filter(e => e.type === "brainstorm.perspective");
      const responses = evts.filter(e => e.type === "brainstorm.response");

      html += `<div class="brainstorm-session">`;
      html += `<div class="brainstorm-header">Session: ${traceId.substring(0, 12)}...</div>`;

      if (perspectives.length > 0) {
        html += `<div class="brainstorm-round">Round 1 — Perspectives</div>`;
        for (const p of perspectives) {
          const payload = p.payload as Record<string, string>;
          html += `<div class="brainstorm-card perspective">`;
          html += `<span class="brainstorm-agent">${p.source_agent}</span>`;
          html += `<span class="brainstorm-perspective">${payload.perspective || "analysis"}</span>`;
          html += `<div class="brainstorm-summary">${(payload.summary || payload.description || JSON.stringify(payload)).toString().substring(0, 150)}...</div>`;
          html += `</div>`;
        }
      }

      if (responses.length > 0) {
        html += `<div class="brainstorm-round">Round 2 — Responses</div>`;
        for (const r of responses) {
          const payload = r.payload as Record<string, string>;
          html += `<div class="brainstorm-card response">`;
          html += `<span class="brainstorm-agent">${r.source_agent}</span>`;
          html += `<div class="brainstorm-summary">${(payload.summary || payload.response || JSON.stringify(payload)).toString().substring(0, 150)}...</div>`;
          html += `</div>`;
        }
      }

      html += `</div>`;
    }
    this.listEl.innerHTML = html;
  }
}
