export class AppError extends Error {
  	constructor(code, message, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	
	}
}
export function assert(condition, code, message, status = 400) {
  	if (!condition) {
		throw new AppError(code, message, status);
	
	}
}
export function errorBody(error) {
	console.error("error: ",error);
	const validation = ['ZodError', 'ValidationError', 'CastError'].includes(error.name);
	return {

		code: error.code || (validation ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR'),
		message: error instanceof AppError ? error.message : validation ? 'Payload validation failed' : 'Internal server error' 
	};
}
