import Phaser from "phaser";
import { OfficeAPI, AgentData, TaskData } from "../api/client.js";
import { AgentSprite } from "../sprites/AgentSprite.js";
import { TaskBoard } from "../ui/TaskBoard.js";
import { AgentPanel } from "../ui/AgentPanel.js";
import { CANVAS_WIDTH, CANVAS_HEIGHT, DEPT_COLORS, SPRITE_SIZE } from "../config.js";
import layout from "../assets/office-layout.json";

interface Room {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  desks: { x: number; y: number }[];
}

export class OfficeScene extends Phaser.Scene {
  private api!: OfficeAPI;
  private agentSprites = new Map<string, AgentSprite>();
  private taskBoard!: TaskBoard;
  private agentPanel!: AgentPanel;
  private rooms: Room[] = layout.rooms as Room[];
  private agents: AgentData[] = [];
  private tasks: TaskData[] = [];
  private taskLines: Phaser.GameObjects.Graphics | null = null;

  constructor() {
    super({ key: "OfficeScene" });
  }

  create(): void {
    this.api = new OfficeAPI();
    this.taskBoard = new TaskBoard();
    this.agentPanel = new AgentPanel();

    // Draw office
    this.drawOffice();

    // Task assignment lines layer (drawn above office, below sprites)
    this.taskLines = this.add.graphics();
    this.taskLines.setDepth(1);

    // Connect to SSE
    this.api.subscribe({
      onAgents: (agents) => {
        this.agents = agents;
        this.syncAgentSprites();
        this.updateHUD();
      },
      onTasks: (tasks) => {
        this.tasks = tasks;
        this.taskBoard.updateTasks(tasks);
        this.drawTaskLines();
        this.updateHUD();
      },
    });
  }

  update(time: number): void {
    for (const [, sprite] of this.agentSprites) {
      sprite.update(time);
    }
  }

  private drawOffice(): void {
    const g = this.add.graphics();

    // Background (hallway)
    g.fillStyle(0x1e1e2e, 1);
    g.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Draw rooms
    for (const room of this.rooms) {
      const color = DEPT_COLORS[room.id] ?? 0x3a3a4a;

      // Room floor
      g.fillStyle(color, 0.3);
      g.fillRoundedRect(room.x, room.y, room.w, room.h, 4);

      // Room border
      g.lineStyle(1, color, 0.6);
      g.strokeRoundedRect(room.x, room.y, room.w, room.h, 4);

      // Room label
      this.add.text(room.x + 6, room.y + 4, room.label, {
        fontSize: "10px",
        fontFamily: "'Courier New', monospace",
        color: "#666677",
      });

      // Draw desks
      for (const desk of room.desks) {
        // Desk shadow
        g.fillStyle(0x18182a, 0.5);
        g.fillRoundedRect(room.x + desk.x - 13, room.y + desk.y - 8, 28, 20, 3);

        // Desk surface
        g.fillStyle(0x2a2a3e, 1);
        g.fillRoundedRect(room.x + desk.x - 14, room.y + desk.y - 10, 28, 20, 3);

        // Desk highlight
        g.fillStyle(0x3a3a4e, 1);
        g.fillRect(room.x + desk.x - 12, room.y + desk.y - 8, 24, 2);

        // Monitor on desk (tiny rectangle)
        g.fillStyle(0x444466, 1);
        g.fillRect(room.x + desk.x - 4, room.y + desk.y - 9, 8, 6);
        g.fillStyle(0x5865f2, 0.3);
        g.fillRect(room.x + desk.x - 3, room.y + desk.y - 8, 6, 4);
      }

      // Room decorations
      if (room.id === "common") {
        // Lounge: coffee table
        g.fillStyle(0x3a3020, 0.5);
        g.fillRoundedRect(room.x + room.w / 2 - 20, room.y + room.h / 2 - 10, 40, 20, 4);
        // Plants
        g.fillStyle(0x2a6a2a, 0.6);
        g.fillCircle(room.x + 30, room.y + 30, 8);
        g.fillCircle(room.x + room.w - 30, room.y + 30, 8);
      }
    }

    // Office title
    this.add.text(CANVAS_WIDTH / 2, CANVAS_HEIGHT - 16, "AI OFFICE", {
      fontSize: "10px",
      fontFamily: "'Courier New', monospace",
      color: "#333344",
    }).setOrigin(0.5);
  }

  /** Draw lines from Leader to assigned workers for active tasks */
  private drawTaskLines(): void {
    if (!this.taskLines) return;
    this.taskLines.clear();

    const activeTasks = this.tasks.filter(
      (t) => t.status === "in_progress" || t.status === "checkpoint" || t.status === "assigned"
    );

    const leaderSprite = this.agentSprites.get("leader");
    if (!leaderSprite) return;

    for (const task of activeTasks) {
      if (!task.assigned_to) continue;
      // Find worker sprite (could be agent_id or role_id match)
      const workerSprite =
        this.agentSprites.get(task.assigned_to) ||
        Array.from(this.agentSprites.values()).find(
          (s) => s.agentData.role_id === task.assigned_to
        );
      if (!workerSprite) continue;

      // Draw dotted line from leader to worker
      const color = task.status === "in_progress" || task.status === "checkpoint"
        ? 0xfaa61a : 0x5865f2;
      this.taskLines.lineStyle(1, color, 0.3);

      const lx = leaderSprite.x, ly = leaderSprite.y;
      const wx = workerSprite.x, wy = workerSprite.y;

      // Dashed line
      const segments = 20;
      for (let i = 0; i < segments; i += 2) {
        const t1 = i / segments;
        const t2 = (i + 1) / segments;
        this.taskLines.lineBetween(
          lx + (wx - lx) * t1, ly + (wy - ly) * t1,
          lx + (wx - lx) * t2, ly + (wy - ly) * t2,
        );
      }
    }
  }

  private syncAgentSprites(): void {
    const currentIds = new Set(this.agents.map((a) => a.agent_id));

    // Remove agents that disappeared
    for (const [id, sprite] of this.agentSprites) {
      if (!currentIds.has(id)) {
        sprite.despawn();
        this.agentSprites.delete(id);
      }
    }

    // Add/update agents
    for (const agent of this.agents) {
      if (agent.status === "offline") {
        const sprite = this.agentSprites.get(agent.agent_id);
        if (sprite) {
          sprite.despawn();
          this.agentSprites.delete(agent.agent_id);
        }
        continue;
      }

      const existing = this.agentSprites.get(agent.agent_id);
      if (existing) {
        existing.updateAgent(agent);
        // If department changed, move to new desk
        if (existing.agentData.department !== agent.department) {
          const pos = this.findDeskPosition(agent);
          existing.walkTo(pos.x, pos.y);
        }
      } else {
        this.spawnAgentSprite(agent);
      }
    }

    // Redraw task lines after sprite sync
    this.drawTaskLines();
  }

  private spawnAgentSprite(agent: AgentData): void {
    const pos = this.findDeskPosition(agent);
    const sprite = new AgentSprite(this, pos.x, pos.y, agent);
    sprite.setDepth(2);

    sprite.on("pointerdown", () => {
      this.agentPanel.show(agent, this.tasks);
    });

    this.agentSprites.set(agent.agent_id, sprite);
  }

  private findDeskPosition(agent: AgentData): { x: number; y: number } {
    const room = this.rooms.find((r) => r.id === agent.department);
    if (!room || room.desks.length === 0) {
      const lounge = this.rooms.find((r) => r.id === "common");
      if (lounge) {
        return {
          x: lounge.x + 40 + Math.random() * (lounge.w - 80),
          y: lounge.y + 40 + Math.random() * (lounge.h - 80),
        };
      }
      return { x: 100, y: 100 };
    }

    const deptAgents = Array.from(this.agentSprites.values()).filter(
      (s) => s.agentData.department === agent.department
    );
    const deskIndex = deptAgents.length % room.desks.length;
    const desk = room.desks[deskIndex];

    return {
      x: room.x + desk.x,
      y: room.y + desk.y,
    };
  }

  private updateHUD(): void {
    const onlineCount = this.agents.filter((a) => a.status !== "offline").length;
    const activeTaskCount = this.tasks.filter(
      (t) => ["in_progress", "checkpoint", "pending", "assigned"].includes(t.status)
    ).length;

    const hudAgents = document.getElementById("hud-agents");
    const hudTasks = document.getElementById("hud-tasks");
    const hudStatus = document.getElementById("hud-status");

    if (hudAgents) hudAgents.textContent = String(onlineCount);
    if (hudTasks) hudTasks.textContent = String(activeTaskCount);
    if (hudStatus) {
      hudStatus.textContent = "Connected";
      hudStatus.style.color = "#57f287";
    }
  }
}
