import type { ConnectionStatus } from '../hooks/use-websocket';

export function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`connection-indicator connection-${status}`}>
      {status === 'connected'
        ? 'Connected'
        : status === 'connecting'
          ? 'Connecting...'
          : 'Disconnected'}
    </span>
  );
}
