/**
 * A very small structured logger.
 *
 * Operators run inside Kubernetes, where logs are collected by the container
 * runtime and usually shipped to a log system (Loki, ELK, ...). One JSON object
 * per line is the format those systems understand best, so we do not pull in a
 * logging framework for this.
 *
 * Rule of the house: never pass secrets (the Hetzner token, root passwords,
 * WireGuard keys, Kubernetes Secret contents) into a logger call.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/** Extra key/value pairs attached to a log line. */
export type LogFields = Record<string, unknown>;

export interface Logger {
    debug(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    warn(message: string, fields?: LogFields): void;
    error(message: string, fields?: LogFields): void;
    /** Returns a new logger that always adds the given fields. */
    child(fields: LogFields): Logger;
}

/** Where log lines go. Injectable so tests can capture them. */
export interface LogSink {
    write(line: string, level: LogLevel): void;
}

const processSink: LogSink = {
    write(line, level) {
        if (level === 'error' || level === 'warn') {
            process.stderr.write(`${line}\n`);
        } else {
            process.stdout.write(`${line}\n`);
        }
    },
};

function serializeError(value: unknown): unknown {
    if (value instanceof Error) {
        // Only name/message/known extras: an axios error carries the whole
        // request, including the Authorization header, in its `config`.
        const extras = value as unknown as Record<string, unknown>;
        return {
            name: value.name,
            message: value.message,
            ...(typeof extras.code === 'string' ? { code: extras.code } : {}),
            ...(typeof extras.status === 'number' ? { status: extras.status } : {}),
        };
    }
    return value;
}

export function createLogger(
    level: LogLevel = 'info',
    base: LogFields = {},
    sink: LogSink = processSink,
): Logger {
    const threshold = LEVEL_ORDER[level];

    function log(lineLevel: LogLevel, message: string, fields: LogFields = {}): void {
        if (LEVEL_ORDER[lineLevel] < threshold) {
            return;
        }

        const payload: Record<string, unknown> = {
            time: new Date().toISOString(),
            level: lineLevel,
            message,
            ...base,
            ...fields,
        };

        if ('error' in payload) {
            payload.error = serializeError(payload.error);
        }

        sink.write(JSON.stringify(payload), lineLevel);
    }

    return {
        debug: (message, fields) => log('debug', message, fields),
        info: (message, fields) => log('info', message, fields),
        warn: (message, fields) => log('warn', message, fields),
        error: (message, fields) => log('error', message, fields),
        child: (fields) => createLogger(level, { ...base, ...fields }, sink),
    };
}

/** A logger that discards everything. Convenient in tests. */
export const nullLogger: Logger = createLogger('error', {}, { write: () => {} });
