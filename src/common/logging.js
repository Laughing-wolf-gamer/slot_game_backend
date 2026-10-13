
export function createConsoleLogger() {
	const secrets = /password|secret|token|authorization|cardUid/i;
	const redact = value => {
		if (value instanceof Date) return value.toISOString();
		if (value instanceof Error) return { name: value.name, message: value.message };
		if (Array.isArray(value)) return value.map(redact);
		if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
			.map(([key, item]) => [key, secrets.test(key) ? '[REDACTED]' : redact(item)]));
		return value;
	};
	const write = (level, fields, message) => console.log(`[${level}] ${message}`, redact(fields) ?? '');

	return {
		debug: (fields, message) => write('DEBUG', fields, message),
		info: (fields, message) => write('INFO', fields, message),
		warn: (fields, message) => write('WARN', fields, message),
		error: (fields, message) => write('ERROR', fields, message)
	};
}
