# Logging Middleware

Add structured logging to all tool executions.

```typescript
import { createMiddleware } from 'armorer';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  timestamp: string;
  toolName: string;
  message: string;
  data?: unknown;
}

class Logger {
  private entries: LogEntry[] = [];

  log(level: LogLevel, toolName: string, message: string, data?: unknown): void {
    const entry: LogEntry = {
      level,
      timestamp: new Date().toISOString(),
      toolName,
      message,
      data,
    };

    this.entries.push(entry);

    // Also log to console
    const logFn = console[level] ?? console.log;
    logFn(
      `[${entry.timestamp}] [${level.toUpperCase()}] [${toolName}] ${message}`,
      data ?? '',
    );
  }

  getEntries(filter?: { level?: LogLevel; toolName?: string }): LogEntry[] {
    if (!filter) return this.entries;

    return this.entries.filter((entry) => {
      if (filter.level && entry.level !== filter.level) return false;
      if (filter.toolName && entry.toolName !== filter.toolName) return false;
      return true;
    });
  }

  clear(): void {
    this.entries = [];
  }
}

function createLoggingMiddleware(logger: Logger, logLevel: LogLevel = 'info') {
  const shouldLog = (level: LogLevel): boolean => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
    return levels.indexOf(level) >= levels.indexOf(logLevel);
  };

  return createMiddleware((toolConfiguration) => {
    const toolName = toolConfiguration.identity.name;
    const originalExecute = toolConfiguration.execute;

    return {
      ...toolConfiguration,
      async execute(params: unknown, context: unknown) {
        if (shouldLog('debug')) {
          logger.log('debug', toolName, 'Executing with params', params);
        }

        const startTime = Date.now();

        try {
          const executeFn =
            typeof originalExecute === 'function'
              ? originalExecute
              : await originalExecute;

          const result = await executeFn(params, context);
          const duration = Date.now() - startTime;

          if (shouldLog('info')) {
            logger.log('info', toolName, `Completed in ${duration}ms`, {
              duration,
              result: typeof result === 'object' ? '<object>' : result,
            });
          }

          return result;
        } catch (error) {
          const duration = Date.now() - startTime;

          if (shouldLog('error')) {
            logger.log('error', toolName, `Failed after ${duration}ms`, {
              duration,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          throw error;
        }
      },
    };
  });
}

// Usage
const logger = new Logger();

const toolbox = createToolbox([], {
  middleware: [createLoggingMiddleware(logger, 'debug')],
});

// Query logs
const errorLogs = logger.getEntries({ level: 'error' });
console.log(`Found ${errorLogs.length} errors`);
```
