export class RelayError extends Error {
    code;
    status;
    details;
    constructor(code, message, status = 400, details) {
        super(message);
        this.code = code;
        this.status = status;
        this.details = details;
        this.name = 'RelayError';
    }
}
export function requireThat(condition, code, message, status = 400) {
    if (!condition)
        throw new RelayError(code, message, status);
}
export function errorBody(error) {
    if (error instanceof RelayError) {
        return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
    }
    return { code: 'INTERNAL_ERROR', message: 'An internal server error occurred. Check the server log.' };
}
