// Errors that carry the HTTP status and a message that is safe to show.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}
/** Input that breaks a rule. The message says which, in plain words. */
export class ValidationError extends HttpError {
  constructor(message) { super(400, message); }
}
export class NotFoundError extends HttpError {
  constructor(what = "thing") { super(404, `no such ${what}`); }
}
/** Wrong password, locked out, or not allowed to sign up. */
export class AuthError extends HttpError {
  constructor(message, status = 401) { super(status, message); }
}
export const forbidden = (message) => new HttpError(403, message);
