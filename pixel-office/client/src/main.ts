import Phaser from "phaser";
import { OfficeScene } from "./scenes/OfficeScene.js";
import { CANVAS_WIDTH, CANVAS_HEIGHT } from "./config.js";

const game = new Phaser.Game({
  type: Phaser.AUTO,
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  pixelArt: true,
  backgroundColor: "#1a1a2e",
  scene: [OfficeScene],
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  parent: "game-container",
});

export default game;
