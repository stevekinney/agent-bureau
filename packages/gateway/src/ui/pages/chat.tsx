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
      <form onSubmit={handleSubmit} className="chat-form">
        <textarea ref={inputRef} placeholder="Type a message..." rows={3} disabled={chat.sending} />
        <button type="submit" disabled={chat.sending}>
          {chat.sending ? 'Sending...' : 'Send'}
        </button>
      </form>
    </main>
  );
}
