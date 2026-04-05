import Phaser from "phaser";
import { SPRITE_SIZE, STATUS_COLORS, DEPT_COLORS } from "../config.js";
import type { AgentData } from "../api/client.js";

export class AgentSprite extends Phaser.GameObjects.Container {
  public agentData: AgentData;
  private body: Phaser.GameObjects.Graphics;
  private statusDot: Phaser.GameObjects.Graphics;
  private nameText: Phaser.GameObjects.Text;
  private bobOffset: number = 0;
  private bobSpeed: number;

  constructor(scene: Phaser.Scene, x: number, y: number, agent: AgentData) {
    super(scene, x, y);
    this.agentData = agent;
    this.bobSpeed = 0.02 + Math.random() * 0.01;

    // Agent body (pixel character)
    this.body = scene.add.graphics();
    this.drawBody();
    this.add(this.body);

    // Status indicator dot
    this.statusDot = scene.add.graphics();
    this.drawStatusDot();
    this.add(this.statusDot);

    // Name label
    this.nameText = scene.add.text(0, SPRITE_SIZE / 2 + 6, this.getShortName(), {
      fontSize: "9px",
      fontFamily: "'Courier New', monospace",
      color: "#cccccc",
      align: "center",
    });
    this.nameText.setOrigin(0.5, 0);
    this.add(this.nameText);

    // Make interactive
    this.setSize(SPRITE_SIZE + 8, SPRITE_SIZE + 20);
    this.setInteractive({ useHandCursor: true });

    scene.add.existing(this);
  }

  private getShortName(): string {
    // "software-engineer-1" → "SE-1"
    const parts = this.agentData.role_id.split("-");
    if (parts.length === 1) return parts[0].substring(0, 3).toUpperCase();
    const initials = parts.map((p) => p[0].toUpperCase()).join("");
    const instance = this.agentData.agent_id.match(/-(\d+)$/)?.[1] || "";
    return `${initials}-${instance}`;
  }

  private drawBody(): void {
    const g = this.body;
    g.clear();

    const deptColor = DEPT_COLORS[this.agentData.department] ?? 0x4a4a4a;
    const s = SPRITE_SIZE;
    const hs = s / 2;

    // Head (circle)
    g.fillStyle(0xf0d0a0, 1); // skin
    g.fillCircle(0, -hs + 4, 5);

    // Body (rectangle)
    g.fillStyle(deptColor, 1);
    g.fillRoundedRect(-6, -hs + 9, 12, 10, 2);

    // Legs
    g.fillStyle(0x333344, 1);
    g.fillRect(-5, -hs + 19, 4, 5);
    g.fillRect(1, -hs + 19, 4, 5);
  }

  private drawStatusDot(): void {
    const g = this.statusDot;
    g.clear();
    const color = STATUS_COLORS[this.agentData.status] ?? 0x99aab5;
    g.fillStyle(color, 1);
    g.fillCircle(SPRITE_SIZE / 2 - 2, -SPRITE_SIZE / 2, 3);

    // Pulse for busy
    if (this.agentData.status === "busy") {
      g.lineStyle(1, color, 0.4);
      g.strokeCircle(SPRITE_SIZE / 2 - 2, -SPRITE_SIZE / 2, 5);
    }
  }

  updateAgent(agent: AgentData): void {
    this.agentData = agent;
    this.drawBody();
    this.drawStatusDot();
  }

  update(time: number): void {
    // Idle bobbing animation
    if (this.agentData.status === "idle" || this.agentData.status === "online") {
      this.bobOffset = Math.sin(time * this.bobSpeed) * 1.5;
      this.body.y = this.bobOffset;
    } else if (this.agentData.status === "busy") {
      // Busy: slight vibrate
      this.body.x = Math.sin(time * 0.1) * 0.5;
    }
  }
}
