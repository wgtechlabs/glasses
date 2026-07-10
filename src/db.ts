import postgres from "postgres";
import type { Conversation, Job, Message } from "./types";

/**
 * Thin persistence layer over Postgres. Owns schema creation and
 * conversation/message/job CRUD. Callers pass fully-formed domain objects;
 * this class only handles the SQL <-> object mapping.
 */
export class Database {
  private client: postgres.Sql;

  constructor(databaseUrl: string) {
    this.client = postgres(databaseUrl);
  }

  async initialize(): Promise<void> {
    await this.client`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        repository TEXT NOT NULL,
        sandbox_id TEXT,
        session_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.client`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        channel TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.client`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    await this.client`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)
    `;
    await this.client`
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)
    `;
    await this.client`
      CREATE INDEX IF NOT EXISTS idx_jobs_conversation_id ON jobs(conversation_id)
    `;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const rows = await this.client`
      SELECT * FROM conversations WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToConversation(rows[0]);
  }

  /**
   * Finds the most recently updated conversation for a user, optionally
   * scoped to a channel. Used to route a plain follow-up message to the
   * right sandbox without requiring the user to repeat /new.
   */
  async getLatestConversationForUser(
    userId: string,
    channel: string
  ): Promise<Conversation | null> {
    const rows = await this.client`
      SELECT * FROM conversations
      WHERE user_id = ${userId} AND channel = ${channel}
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    return rowToConversation(rows[0]);
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    await this.client`
      INSERT INTO conversations (
        id, channel, user_id, agent, repository, sandbox_id, session_id, created_at, updated_at
      ) VALUES (
        ${conversation.id}, ${conversation.channel}, ${conversation.userId},
        ${conversation.agent}, ${conversation.repository}, ${conversation.sandboxId},
        ${conversation.sessionId}, ${conversation.createdAt}, ${conversation.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        sandbox_id = EXCLUDED.sandbox_id,
        session_id = EXCLUDED.session_id,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async saveMessage(message: Message): Promise<void> {
    await this.client`
      INSERT INTO messages (id, conversation_id, channel, user_id, content, created_at)
      VALUES (
        ${message.id}, ${message.conversationId}, ${message.channel},
        ${message.userId}, ${message.content}, ${message.createdAt}
      )
    `;
  }

  async saveJob(job: Job): Promise<void> {
    await this.client`
      INSERT INTO jobs (id, conversation_id, prompt, status, result, error, created_at, updated_at)
      VALUES (
        ${job.id}, ${job.conversationId}, ${job.prompt}, ${job.status},
        ${job.result}, ${job.error}, ${job.createdAt}, ${job.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        result = EXCLUDED.result,
        error = EXCLUDED.error,
        updated_at = EXCLUDED.updated_at
    `;
  }

  async getJob(id: string): Promise<Job | null> {
    const rows = await this.client`
      SELECT * FROM jobs WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      conversationId: row.conversation_id,
      prompt: row.prompt,
      status: row.status,
      result: row.result,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    channel: row.channel as Conversation["channel"],
    userId: row.user_id as string,
    agent: row.agent as Conversation["agent"],
    repository: row.repository as string,
    sandboxId: (row.sandbox_id as string) ?? null,
    sessionId: (row.session_id as string) ?? null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
