import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SessionInfo, SessionPersistenceAdapter } from '../environment';
import type { ConversationHistory } from '../types';

export class JsonlSessionPersistenceAdapter implements SessionPersistenceAdapter {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  private filePath(id: string): string {
    return join(this.directory, `${id}.jsonl`);
  }

  private ensureDirectory(): void {
    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { recursive: true });
    }
  }

  async save(conversation: ConversationHistory): Promise<void> {
    this.ensureDirectory();
    const line = JSON.stringify(conversation);
    await Bun.write(this.filePath(conversation.id), line + '\n');
  }

  async load(id: string): Promise<ConversationHistory | undefined> {
    const path = this.filePath(id);
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;

    const text = await file.text();
    const lines = text.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (!lastLine) return undefined;

    return JSON.parse(lastLine) as ConversationHistory;
  }

  async list(): Promise<SessionInfo[]> {
    if (!existsSync(this.directory)) return [];

    const glob = new Bun.Glob('*.jsonl');
    const sessions: SessionInfo[] = [];

    for await (const file of glob.scan({ cwd: this.directory })) {
      const path = join(this.directory, file);
      const text = await Bun.file(path).text();
      const lines = text.trim().split('\n').filter(Boolean);
      const lastLine = lines[lines.length - 1];
      if (!lastLine) continue;

      const conversation = JSON.parse(lastLine) as ConversationHistory;
      sessions.push({
        id: conversation.id,
        ...(conversation.title !== undefined ? { title: conversation.title } : {}),
        tags: (conversation.metadata['_tags'] as string[] | undefined) ?? [],
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.ids.length,
      });
    }

    return sessions;
  }

  async delete(id: string): Promise<void> {
    const path = this.filePath(id);
    const file = Bun.file(path);
    if (await file.exists()) {
      const { unlinkSync } = await import('node:fs');
      unlinkSync(path);
    }
  }
}
