/**
 * Tiny structured logger for Mehen. Plain JSON one-line records to stdout
 * so cron logs are easily greppable. No fancy library dependency on an
 * agent that runs in restricted server environments.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: Level;
  msg: string;
  [key: string]: unknown;
}

function emit(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  // Errors go to stderr, everything else to stdout.
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + '\n');
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => {
    if (process.env.MEHEN_DEBUG === '1') emit('debug', msg, fields);
  },
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};
