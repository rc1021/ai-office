export const API_BASE = "/api";
export const CANVAS_WIDTH = 960;
export const CANVAS_HEIGHT = 608; // Leave 32px for HUD

// Department colors (matching channels.yaml departments)
export const DEPT_COLORS: Record<string, number> = {
  management: 0x4a4a6a,
  engineering: 0x3a5a3a,
  finance: 0x5a4a3a,
  marketing: 0x5a3a5a,
  research: 0x3a4a5a,
  operations: 0x4a5a4a,
  design: 0x5a5a3a,
  hr: 0x4a3a5a,
  legal: 0x3a5a5a,
  sales: 0x5a4a4a,
  support: 0x4a4a4a,
};

// Status colors
export const STATUS_COLORS: Record<string, number> = {
  online: 0x57f287,
  idle: 0x57f287,
  busy: 0xfaa61a,
  offline: 0x99aab5,
};

// Agent sprite size
export const SPRITE_SIZE = 24;
export const DESK_SIZE = 32;
