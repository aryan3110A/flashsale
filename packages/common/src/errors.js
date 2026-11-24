/** Operational error carrying an HTTP status and a stable machine readable code. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Single response shape for every service: { success:false, error:"CODE", message, requestId, details? } */
export function errorBody(code, message, requestId, details) {
  const body = { success: false, error: code, message };
  if (requestId) body.requestId = requestId;
  if (details !== undefined) body.details = details;
  return body;
}
