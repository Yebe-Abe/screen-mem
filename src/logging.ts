// Tiny structured logger to stderr. We don't ship a logging library in V1 —
// the value isn't worth the dependency. The interface is shaped so a real
// logger can drop in later without changing call sites.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  error(msg: string, meta?: object): void;
  child(component: string): Logger;
}

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentLevel(): number {
  const env = (process.env.SCREEN_MEMORY_LOG_LEVEL ?? "info").toLowerCase();
  return LEVELS[env as LogLevel] ?? LEVELS.info;
}

function emit(
  component: string,
  level: LogLevel,
  msg: string,
  meta?: object
): void {
  if (LEVELS[level] < currentLevel()) return;
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
  process.stderr.write(`${ts} ${level.padEnd(5)} [${component}] ${msg}${metaStr}\n`);
}

export function createLogger(component: string): Logger {
  return {
    debug: (m, e) => emit(component, "debug", m, e),
    info: (m, e) => emit(component, "info", m, e),
    warn: (m, e) => emit(component, "warn", m, e),
    error: (m, e) => emit(component, "error", m, e),
    child: (sub) => createLogger(`${component}:${sub}`),
  };
}
