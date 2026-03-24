import type { ChatMessage } from '../hooks/use-chat';

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="message-list">
      {messages.map((message, index) => (
        <div key={index} className={`message message-${message.role}`}>
          <strong>{message.role}:</strong>
          <p>{message.content}</p>
        </div>
      ))}
    </div>
  );
}
