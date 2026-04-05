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

  constructor() {
    super({ key: "OfficeScene" });
  }

  create(): void {
    this.api = new OfficeAPI();
    this.taskBoard = new TaskBoard();
    this.agentPanel = new AgentPanel();

    // Draw office
    this.drawOffice();

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
        this.updateHUD();
      },
    });
  }

  update(time: number): void {
    // Animate agent sprites
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
      g.fillStyle(color, 0.4);
      g.fillRect(room.x, room.y, room.w, room.h);

      // Room border
      g.lineStyle(1, color, 0.8);
      g.strokeRect(room.x, room.y, room.w, room.h);

      // Room label
      this.add.text(room.x + 6, room.y + 4, room.label, {
        fontSize: "10px",
        fontFamily: "'Courier New', monospace",
        color: "#888888",
      });

      // Draw desks
      for (const desk of room.desks) {
        g.fillStyle(0x2a2a3e, 1);
        g.fillRoundedRect(
          room.x + desk.x - 14,
          room.y + desk.y - 10,
          28,
          20,
          3
        );
        // Desk surface highlight
        g.fillStyle(0x3a3a4e, 1);
        g.fillRect(room.x + desk.x - 12, room.y + desk.y - 8, 24, 2);
      }
    }

    // Office title
    this.add.text(CANVAS_WIDTH / 2, CANVAS_HEIGHT - 16, "AI OFFICE", {
      fontSize: "10px",
      fontFamily: "'Courier New', monospace",
      color: "#333344",
    }).setOrigin(0.5);
  }

  private syncAgentSprites(): void {
    const currentIds = new Set(this.agents.map((a) => a.agent_id));

    // Remove agents that went offline
    for (const [id, sprite] of this.agentSprites) {
      if (!currentIds.has(id)) {
        sprite.destroy();
        this.agentSprites.delete(id);
      }
    }

    // Add/update agents
    for (const agent of this.agents) {
      if (agent.status === "offline") {
        // Remove offline agents
        const sprite = this.agentSprites.get(agent.agent_id);
        if (sprite) {
          sprite.destroy();
          this.agentSprites.delete(agent.agent_id);
        }
        continue;
      }

      const existing = this.agentSprites.get(agent.agent_id);
      if (existing) {
        existing.updateAgent(agent);
      } else {
        this.spawnAgentSprite(agent);
      }
    }
  }

  private spawnAgentSprite(agent: AgentData): void {
    const pos = this.findDeskPosition(agent);
    const sprite = new AgentSprite(this, pos.x, pos.y, agent);

    sprite.on("pointerdown", () => {
      this.agentPanel.show(agent);
    });

    this.agentSprites.set(agent.agent_id, sprite);
  }

  private findDeskPosition(agent: AgentData): { x: number; y: number } {
    // Find the room for this agent's department
    const room = this.rooms.find((r) => r.id === agent.department);
    if (!room || room.desks.length === 0) {
      // Fallback: common area / lounge
      const lounge = this.rooms.find((r) => r.id === "common");
      if (lounge) {
        return {
          x: lounge.x + 40 + Math.random() * (lounge.w - 80),
          y: lounge.y + 40 + Math.random() * (lounge.h - 80),
        };
      }
      return { x: 100, y: 100 };
    }

    // Count how many agents are already in this department
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
    const onlineCount = this.agents.filter(
      (a) => a.status !== "offline"
    ).length;
    const activeTaskCount = this.tasks.filter(
      (t) =>
        t.status === "in_progress" ||
        t.status === "checkpoint" ||
        t.status === "pending" ||
        t.status === "assigned"
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
