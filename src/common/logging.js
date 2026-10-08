
export function createConsoleLogger() {
	const write = (level, fields, message) => console.log(`[${level}] ${message}`, fields ?? '');

	return {
		debug: (fields, message) => write('DEBUG', fields, message),
		info: (fields, message) => write('INFO', fields, message),
		warn: (fields, message) => write('WARN', fields, message),
		error: (fields, message) => write('ERROR', fields, message)
	};
}