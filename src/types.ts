export type ChannelName = "telegram" | "discord" | "whatsapp";
export type AgentName = "copilot" | "devin";

export interface Message {
  id: string;
  conversationId: string;
  channel: ChannelName;
  userId: string;
  content: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  channel: ChannelName;
  userId: string;
  agent: AgentName;
  repository: string;
  sandboxId: string | null;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobStatus = "pending" | "running" | "done" | "failed";

export interface Job {
  id: string;
  conversationId: string;
  prompt: string;
  status: JobStatus;
  result: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Config {
  railwayApiToken: string;
  railwayEnvironmentId: string;
  databaseUrl: string;
  telegramBotToken: string;
  telegramAllowedUserId: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
}
