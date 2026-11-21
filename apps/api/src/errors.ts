export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'BAD_REQUEST', msg, details);
export const forbidden = (msg: string) => new HttpError(403, 'FORBIDDEN', msg);
export const notFound = (msg: string) => new HttpError(404, 'NOT_FOUND', msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, 'CONFLICT', msg, details);
