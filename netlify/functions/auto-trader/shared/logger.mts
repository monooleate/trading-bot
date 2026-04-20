import type { LogEntry, LogEvent } from "./types.mts";

const logBuffer: string[] = [];

export function log(event: LogEvent, paper: boolean, data: Record<string, unknown> = {}) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    event,
    paper,
    ...data,
  };
  const line = JSON.stringify(entry);
  logBuffer.push(line);
  console.log(line);
}

export function getLogBuffer(): string[] {
  return [...logBuffer];
}

export function clearLogBuffer(): void {
  logBuffer.length = 0;
}
