import { ConsoleLogger, type LoggerService, type LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context.js';

const LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/**
 * One JSON object per line: easy for log tools to parse and search, e.g. by
 * requestId to follow one request across services. Pretty output stays the
 * default for local development; set LOG_FORMAT=json to switch.
 */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly service: string,
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly minLevel: LogLevel = 'log',
  ) {}

  log(message: unknown, ...rest: unknown[]) {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('fatal', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    if (LEVELS.indexOf(level) > LEVELS.indexOf(this.minLevel)) return;
    // Nest passes the context (class name) as the last string argument, and a stack for errors.
    const args = [...rest];
    const context = typeof args[args.length - 1] === 'string' ? (args.pop() as string) : undefined;
    const stack = level === 'error' && typeof args[0] === 'string' ? (args.shift() as string) : undefined;
    const fields = message !== null && typeof message === 'object' ? (message as Record<string, unknown>) : { msg: String(message) };
    const requestId = currentRequestId();
    this.write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        service: this.service,
        ...(context && { context }),
        ...(requestId && { requestId }),
        ...fields,
        ...(stack && { stack }),
      }),
    );
  }
}

export function createLogger(service: string): LoggerService {
  return process.env.LOG_FORMAT === 'json' ? new JsonLogger(service) : new ConsoleLogger();
}
