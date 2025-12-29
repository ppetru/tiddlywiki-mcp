// ABOUTME: Logging utility with timestamps and debug mode support
// ABOUTME: Set LOG_DEBUG=true to enable verbose debug logging

const DEBUG_ENABLED = process.env.LOG_DEBUG === 'true';

function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Log informational messages (always shown)
 */
export function log(message: string, ...args: unknown[]): void {
  console.log(`[${getTimestamp()}]`, message, ...args);
}

/**
 * Log error messages (always shown)
 */
export function error(message: string, ...args: unknown[]): void {
  console.error(`[${getTimestamp()}]`, message, ...args);
}

/**
 * Log warning messages (always shown)
 */
export function warn(message: string, ...args: unknown[]): void {
  console.warn(`[${getTimestamp()}]`, message, ...args);
}

/**
 * Log debug messages (only shown when LOG_DEBUG=true)
 */
export function debug(message: string, ...args: unknown[]): void {
  if (DEBUG_ENABLED) {
    console.log(`[${getTimestamp()}] [DEBUG]`, message, ...args);
  }
}
