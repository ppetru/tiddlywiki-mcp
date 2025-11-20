/**
 * Logging utility with timestamps
 */

function getTimestamp(): string {
  return new Date().toISOString();
}

export function log(message: string, ...args: any[]): void {
  console.log(`[${getTimestamp()}]`, message, ...args);
}

export function error(message: string, ...args: any[]): void {
  console.error(`[${getTimestamp()}]`, message, ...args);
}

export function warn(message: string, ...args: any[]): void {
  console.warn(`[${getTimestamp()}]`, message, ...args);
}
