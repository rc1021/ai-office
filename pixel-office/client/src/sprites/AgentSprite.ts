import Phaser from "phaser";
import { SPRITE_SIZE, STATUS_COLORS, DEPT_COLORS } from "../config.js";
import type { AgentData } from "../api/client.js";

export class AgentSprite extends Phaser.GameObjects.Container {
  public agentData: AgentData;
  private gfxBody: Phaser.GameObjects.Graphics;
  private statusDot: Phaser.GameObjects.Graphics;
  private heartbeatRing: Phaser.GameObjects.Graphics;
  private progressRing: Phaser.GameObjects.Graphics;
  private nameText: Phaser.GameObjects.Text;
  private bubble: Phaser.GameObjects.Graphics | null = null;
  private bubbleText: Phaser.GameObjects.Text | null = null;
  private bobSpeed: number;
  private targetX: number;
  private targetY: number;
  private walkSpeed = 1.2;
  private isMoving = false;
  private lastHeartbeat: string = "";
  private taskProgress: number = 0;
  private hasActiveTask: boolean = false;

  constructor(scene: Phaser.Scene, x: number, y: number, agent: AgentData) {
    super(scene, x, y);
    this.agentData = agent;
    this.targetX = x;
    this.targetY = y;
    this.bobSpeed = 0.02 + Math.random() * 0.01;

    // Agent body (pixel character)
    this.gfxBody = scene.add.graphics();
    this.drawBody();
    this.add(this.gfxBody);

    // Status indicator dot
    this.statusDot = scene.add.graphics();
    this.drawStatusDot();
    this.add(this.statusDot);

    // Heartbeat health ring
    this.heartbeatRing = scene.add.graphics();
    this.add(this.heartbeatRing);

    // Task progress ring
    this.progressRing = scene.add.graphics();
    this.add(this.progressRing);

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

    // Spawn animation: fade in + scale up
    this.setAlpha(0);
    this.setScale(0.3);
    scene.tweens.add({
      targets: this as unknown as Phaser.GameObjects.GameObject,
      alpha: 1,
      scale: 1,
      duration: 400,
      ease: "Back.easeOut",
    });

    scene.add.existing(this);
  }

  private getShortName(): string {
    const parts = this.agentData.role_id.split("-");
    if (parts.length === 1) return parts[0].substring(0, 3).toUpperCase();
    const initials = parts.map((p) => p[0].toUpperCase()).join("");
    const instance = this.agentData.agent_id.match(/-(\d+)$/)?.[1] || "";
    return instance ? `${initials}-${instance}` : initials;
  }

  private drawBody(): void {
    const g = this.gfxBody;
    g.clear();

    const deptColor = DEPT_COLORS[this.agentData.department] ?? 0x4a4a4a;
    const hs = SPRITE_SIZE / 2;

    // Head (circle)
    g.fillStyle(0xf0d0a0, 1);
    g.fillCircle(0, -hs + 4, 5);

    // Eyes (tiny dots)
    g.fillStyle(0x333333, 1);
    g.fillCircle(-2, -hs + 3, 1);
    g.fillCircle(2, -hs + 3, 1);

    // Body (rectangle)
    g.fillStyle(deptColor, 1);
    g.fillRoundedRect(-6, -hs + 9, 12, 10, 2);

    // Legs
    g.fillStyle(0x333344, 1);
    g.fillRect(-5, -hs + 19, 4, 5);
    g.fillRect(1, -hs + 19, 4, 5);

    // Role indicator (small icon on body)
    if (this.agentData.status === "busy") {
      // Typing indicator: three dots on body
      g.fillStyle(0xffffff, 0.6);
      g.fillCircle(-3, -hs + 14, 1);
      g.fillCircle(0, -hs + 14, 1);
      g.fillCircle(3, -hs + 14, 1);
    }
  }

  private drawStatusDot(): void {
    const g = this.statusDot;
    g.clear();
    const color = STATUS_COLORS[this.agentData.status] ?? 0x99aab5;
    g.fillStyle(color, 1);
    g.fillCircle(SPRITE_SIZE / 2 - 2, -SPRITE_SIZE / 2, 3);

    // Pulse ring for busy
    if (this.agentData.status === "busy") {
      g.lineStyle(1, color, 0.4);
      g.strokeCircle(SPRITE_SIZE / 2 - 2, -SPRITE_SIZE / 2, 5);
    }
  }

  /** Move agent to a new desk position with walk animation */
  walkTo(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.isMoving = true;
  }

  /** Show a speech bubble briefly */
  showBubble(text: string, duration = 3000): void {
    this.clearBubble();

    const g = this.scene.add.graphics();
    const padding = 4;
    const maxWidth = 80;
    const t = this.scene.add.text(0, -SPRITE_SIZE - 16, text, {
      fontSize: "8px",
      fontFamily: "'Courier New', monospace",
      color: "#ffffff",
      wordWrap: { width: maxWidth },
      align: "center",
    });
    t.setOrigin(0.5, 1);

    // Bubble background
    const bounds = t.getBounds();
    g.fillStyle(0x28283c, 0.9);
    g.fillRoundedRect(
      -bounds.width / 2 - padding,
      -SPRITE_SIZE - 16 - bounds.height - padding,
      bounds.width + padding * 2,
      bounds.height + padding * 2,
      4
    );
    // Bubble tail
    g.fillTriangle(
      -3, -SPRITE_SIZE - 16,
      3, -SPRITE_SIZE - 16,
      0, -SPRITE_SIZE - 12,
    );

    this.add(g);
    this.add(t);
    this.bubble = g;
    this.bubbleText = t;

    // Auto-hide
    this.scene.time.delayedCall(duration, () => this.clearBubble());
  }

  private clearBubble(): void {
    if (this.bubble) { this.bubble.destroy(); this.bubble = null; }
    if (this.bubbleText) { this.bubbleText.destroy(); this.bubbleText = null; }
  }

  public updateTaskProgress(progress: number, hasTask: boolean): void {
    this.taskProgress = progress;
    this.hasActiveTask = hasTask;
  }

  updateAgent(agent: AgentData): void {
    const prevStatus = this.agentData.status;
    this.agentData = agent;
    this.lastHeartbeat = agent.last_heartbeat || "";
    this.drawBody();
    this.drawStatusDot();

    // Status change bubble
    if (prevStatus !== agent.status) {
      if (agent.status === "busy") this.showBubble("Working...");
      else if (agent.status === "idle" && prevStatus === "busy") this.showBubble("Done!");
      else if (agent.status === "online") this.showBubble("Online");
    }
  }

  /** Despawn with fade-out animation, then destroy */
  despawn(): void {
    this.scene.tweens.add({
      targets: this as unknown as Phaser.GameObjects.GameObject,
      alpha: 0,
      scale: 0.3,
      duration: 300,
      ease: "Back.easeIn",
      onComplete: () => this.destroy(),
    });
  }

  update(time: number): void {
    // Walk animation
    if (this.isMoving) {
      const dx = this.targetX - this.x;
      const dy = this.targetY - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 2) {
        this.x = this.targetX;
        this.y = this.targetY;
        this.isMoving = false;
      } else {
        this.x += (dx / dist) * this.walkSpeed;
        this.y += (dy / dist) * this.walkSpeed;
        // Walking leg animation
        const legOffset = Math.sin(time * 0.15) * 2;
        this.gfxBody.y = Math.abs(legOffset) * 0.3; // slight bounce
      }
      return;
    }

    // Idle bobbing animation
    if (this.agentData.status === "idle" || this.agentData.status === "online") {
      this.gfxBody.y = Math.sin(time * this.bobSpeed) * 1.5;
    } else if (this.agentData.status === "busy") {
      // Busy: typing vibrate
      this.gfxBody.x = Math.sin(time * 0.1) * 0.5;
      // Pulsing status dot
      const pulse = 0.5 + Math.sin(time * 0.05) * 0.3;
      this.statusDot.setAlpha(pulse);
    } else {
      this.gfxBody.x = 0;
      this.gfxBody.y = 0;
      this.statusDot.setAlpha(1);
    }

    // Heartbeat ring
    this.heartbeatRing.clear();
    if (this.lastHeartbeat) {
      const ageMs = Date.now() - new Date(this.lastHeartbeat + (this.lastHeartbeat.includes("Z") ? "" : "Z")).getTime();
      const ageSec = ageMs / 1000;

      let color: number;
      let beatSpeed: number;
      let ringAlpha: number;

      if (ageSec < 60) {
        color = 0x57f287; beatSpeed = 0.008; ringAlpha = 0.5;
      } else if (ageSec < 300) {
        color = 0xfee75c; beatSpeed = 0.004; ringAlpha = 0.4;
      } else if (ageSec < 900) {
        color = 0xf39c12; beatSpeed = 0; ringAlpha = 0.3;
      } else {
        color = 0xed4245; beatSpeed = 0; ringAlpha = 0.2;
      }

      const pulse = beatSpeed > 0 ? Math.sin(time * beatSpeed) * 2 : 0;
      const radius = 14 + pulse;

      this.heartbeatRing.lineStyle(1, color, ringAlpha);
      this.heartbeatRing.strokeCircle(0, -12, radius);
    }

    // Task progress ring
    this.progressRing.clear();
    if (this.hasActiveTask && this.taskProgress > 0) {
      const startAngle = -Math.PI / 2;
      const endAngle = startAngle + (Math.PI * 2 * this.taskProgress);
      const color = this.taskProgress >= 1 ? 0x57f287 : 0xfaa61a;

      this.progressRing.lineStyle(2, color, 0.7);
      const segments = 32;
      const radius = 16;
      const step = (endAngle - startAngle) / segments;
      for (let i = 0; i < segments; i++) {
        const a1 = startAngle + step * i;
        const a2 = startAngle + step * (i + 1);
        this.progressRing.lineBetween(
          Math.cos(a1) * radius, -12 + Math.sin(a1) * radius,
          Math.cos(a2) * radius, -12 + Math.sin(a2) * radius
        );
      }
    }
  }
}
