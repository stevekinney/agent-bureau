import { type FormEvent, useCallback, useRef } from 'react';

import { MessageList } from '../components/message-list';
import type { UseChatResult } from '../hooks/use-chat';

export function ChatPage({ chat }: { chat: UseChatResult }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const input = inputRef.current;
      if (!input?.value.trim()) return;
      void chat.send(input.value.trim());
      input.value = '';
    },
    [chat],
  );

  return (
    <main className="page-chat">
      <h1>Chat</h1>
      <MessageList messages={chat.messages} />
      {chat.streamingAssistantContent ? (
        <div className="message message-assistant message-streaming">
          <strong>assistant:</strong>
          <p>{chat.streamingAssistantContent}</p>
        </div>
      ) : null}
      {chat.toolActivity.length > 0 ? (
        <section className="chat-tool-activity">
          <h2>Tool Activity</h2>
          <ul>
            {chat.toolActivity.map((entry, index) => (
              <li key={`${entry}-${index}`}>{entry}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {chat.error ? <p className="error">{chat.error}</p> : null}
      <form onSubmit={handleSubmit} className="chat-form">
        <textarea ref={inputRef} placeholder="Type a message..." rows={3} disabled={chat.sending} />
        <button type="submit" disabled={chat.sending}>
          {chat.sending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </main>
  );
}
