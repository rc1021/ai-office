export type RiskLevel = "GREEN" | "YELLOW" | "RED";

export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalRequest {
  id: string;
  channelName: string;
  action: string;
  description: string;
  riskLevel: RiskLevel;
  status: ApprovalStatus;
  messageId: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

export interface EmbedField {
  name: string;
  value: string;
}

export interface EmbedInput {
  title: string;
  description: string;
  color?: number;
  fields?: EmbedField[];
  footer?: string;
}

export interface ChannelMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
  isBot: boolean;
}

export interface ServerSetupResult {
  created: string[];
  skipped: string[];
  errors: string[];
}
