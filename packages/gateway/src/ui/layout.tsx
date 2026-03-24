import type { ReactNode } from 'react';

import { ConnectionIndicator } from './components/connection-indicator';
import type { ConnectionStatus } from './hooks/use-websocket';

const navLinks = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/chat', label: 'Chat' },
  { href: '/configuration', label: 'Configuration' },
];

export function Layout({
  children,
  connectionStatus,
}: {
  children: ReactNode;
  connectionStatus: ConnectionStatus;
}) {
  return (
    <div className="layout">
      <nav className="sidebar">
        <h2 className="sidebar-title">Agent Bureau</h2>
        <ul className="nav-links">
          {navLinks.map((link) => (
            <li key={link.href}>
              <a href={link.href}>{link.label}</a>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <ConnectionIndicator status={connectionStatus} />
        </div>
      </nav>
      <div className="main-content">{children}</div>
    </div>
  );
}
