import { Request } from "express";
import type { Logger } from "winston";

export interface UserData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

export interface RegisterUserRequest extends Request {
  body: UserData;
}

export interface LoginUserRequest extends Request {
  body: { email: string; password: string };
}

export interface ForgotPasswordRequest extends Request {
  body: { email: string };
}

export interface ResetPasswordRequest extends Request {
  body: { token: string; password: string };
}

export interface TokenRequest extends Request {
  body: { token: string };
}

/** Claims carried by the access token, attached to the request by `authenticate`. */
export interface AuthPayload {
  sub: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request, echoed back as `x-request-id`. */
      id: string;
      /** Child logger pre-tagged with the request id. */
      log: Logger;
      /** Present only after `authenticate` has run. */
      auth?: AuthPayload;
    }
  }
}
