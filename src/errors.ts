export class RelayError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) {
    super(message);
    this.name = 'RelayError';
  }
}

export function requireThat(condition: unknown, code: string, message: string, status = 400): asserts condition {
  if (!condition) throw new RelayError(code, message, status);
}

export function errorBody(error: unknown) {
  if (error instanceof RelayError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  }
  return { code: 'INTERNAL_ERROR', message: 'An internal server error occurred. Check the server log.' };
}
