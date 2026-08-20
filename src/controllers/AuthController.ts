import type { NextFunction, Request, Response } from "express";
import type { Logger } from "winston";
import type { JwtPayload } from "jsonwebtoken";
import createHttpError from "http-errors";
import { UserService } from "../services/UserService.js";
import { TokenService } from "../services/TokenService.js";
import { CredentialService } from "../services/CredentialService.js";
import { VerificationTokenService } from "../services/VerificationTokenService.js";
import { MailService } from "../services/MailService.js";
import { VerificationTokenType } from "../entity/VerificationToken.js";
import { User } from "../entity/User.js";
import { Config } from "../config/index.js";
import { clearAuthCookies, setAuthCookies } from "../utils/cookies.js";
import type {
  ForgotPasswordRequest,
  LoginUserRequest,
  RegisterUserRequest,
  ResetPasswordRequest,
  TokenRequest,
} from "../types/index.js";

/** Deliberately identical for "no such user" and "wrong password". */
const CREDENTIALS_REJECTED = "Email or password does not match";

export class AuthController {
  constructor(
    private userService: UserService,
    private logger: Logger,
    private tokenService: TokenService,
    private credentialService: CredentialService,
    private verificationTokenService: VerificationTokenService,
    private mailService: MailService,
  ) {}

  /** Mint an access token plus a fresh refresh-token family and set both cookies. */
  private async issueSession(user: User, res: Response) {
    const payload: JwtPayload = { sub: String(user.id), role: user.role };
    const accessToken = this.tokenService.generateAccessToken(payload);
    const refreshTokenRecord = await this.tokenService.startFamily(user);
    const refreshToken = this.tokenService.generateRefreshToken({
      ...payload,
      id: String(refreshTokenRecord.id),
    });
    setAuthCookies(res, accessToken, refreshToken);
  }

  async register(req: RegisterUserRequest, res: Response, next: NextFunction) {
    const { firstName, lastName, email, password } = req.body;
    req.log.info("registration requested", { email });

    try {
      const user = await this.userService.create({
        firstName,
        lastName,
        email,
        password,
      });
      req.log.info("user registered", { userId: user.id });

      await this.issueSession(user, res);
      await this.sendVerificationEmail(user, req);

      res.status(201).json({ userId: user.id });
    } catch (err) {
      next(err);
    }
  }

  async login(req: LoginUserRequest, res: Response, next: NextFunction) {
    const { email, password } = req.body;
    req.log.info("login requested", { email });

    try {
      const user = await this.userService.findByEmail(email);
      if (!user) {
        return next(createHttpError(400, CREDENTIALS_REJECTED));
      }

      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        req.log.warn("login attempt on locked account", { userId: user.id });
        return next(
          createHttpError(
            423,
            "Account is temporarily locked after too many failed attempts",
          ),
        );
      }

      // `await` is load-bearing: bcrypt.compare returns a Promise, and an
      // un-awaited Promise is always truthy, which would accept any password.
      const passwordMatches = await this.credentialService.comparePassword(
        password,
        user.password,
      );

      if (!passwordMatches) {
        await this.userService.registerFailedLogin(user);
        req.log.warn("failed login", { userId: user.id });
        return next(createHttpError(400, CREDENTIALS_REJECTED));
      }

      if (Config.REQUIRE_EMAIL_VERIFICATION && !user.emailVerified) {
        return next(
          createHttpError(403, "Email address has not been verified"),
        );
      }

      await this.userService.clearFailedLogins(user);
      await this.issueSession(user, res);
      req.log.info("login succeeded", { userId: user.id });

      res.status(200).json({ id: user.id });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Rotation with reuse detection. Every refresh burns the presented token and
   * issues its successor inside the same family. Presenting an already-burned
   * token means either an attacker or the legitimate user is replaying a stolen
   * copy - we cannot tell which, so the entire family is revoked and both
   * parties are forced to log in again.
   */
  async refresh(req: Request, res: Response, next: NextFunction) {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) {
      return next(createHttpError(401, "Refresh token is missing"));
    }

    let payload: JwtPayload;
    try {
      payload = this.tokenService.verifyRefreshToken(token);
    } catch {
      clearAuthCookies(res);
      return next(createHttpError(401, "Refresh token is invalid or expired"));
    }

    const tokenId = Number(payload.jti);
    if (!Number.isInteger(tokenId)) {
      clearAuthCookies(res);
      return next(createHttpError(401, "Refresh token is malformed"));
    }

    try {
      const stored = await this.tokenService.findById(tokenId);
      if (!stored) {
        clearAuthCookies(res);
        return next(createHttpError(401, "Refresh token is no longer valid"));
      }

      if (stored.revokedAt !== null) {
        await this.tokenService.revokeFamily(stored.familyId);
        req.log.warn("refresh token reuse detected - family revoked", {
          userId: stored.userId,
          familyId: stored.familyId,
        });
        clearAuthCookies(res);
        return next(createHttpError(401, "Refresh token reuse detected"));
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        clearAuthCookies(res);
        return next(createHttpError(401, "Refresh token has expired"));
      }

      const user = await this.userService.findById(stored.userId);
      if (!user) {
        await this.tokenService.revokeFamily(stored.familyId);
        clearAuthCookies(res);
        return next(createHttpError(401, "Refresh token is no longer valid"));
      }

      const replacement = await this.tokenService.rotate(stored, user);
      const claims: JwtPayload = { sub: String(user.id), role: user.role };
      setAuthCookies(
        res,
        this.tokenService.generateAccessToken(claims),
        this.tokenService.generateRefreshToken({
          ...claims,
          id: String(replacement.id),
        }),
      );

      req.log.info("refresh token rotated", {
        userId: user.id,
        familyId: stored.familyId,
      });
      res.status(200).json({ id: user.id });
    } catch (err) {
      next(err);
    }
  }

  /**
   * Revokes the whole family the presented token belongs to, so logging out on
   * one device cannot be undone by a refresh token already rotated from it.
   * It needs the refresh cookie, not a live access token, so a user whose
   * access token has expired can still log out.
   */
  async logout(req: Request, res: Response, next: NextFunction) {
    const token = req.cookies?.refreshToken as string | undefined;
    try {
      if (token) {
        try {
          const payload = this.tokenService.verifyRefreshToken(token);
          const stored = await this.tokenService.findById(Number(payload.jti));
          if (stored) await this.tokenService.revokeFamily(stored.familyId);
        } catch {
          // An unusable token needs no revoking; clearing the cookies is still
          // the right outcome, so this is not an error for the caller.
          req.log.info("logout with unusable refresh token");
        }
      }
      clearAuthCookies(res);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  async self(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await this.userService.findById(Number(req.auth!.sub));
      if (!user) {
        return next(createHttpError(404, "User not found"));
      }
      res.status(200).json({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        role: user.role,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      });
    } catch (err) {
      next(err);
    }
  }

  /** Always 202: answering differently would tell an attacker which emails exist. */
  async forgotPassword(
    req: ForgotPasswordRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const user = await this.userService.findByEmail(req.body.email);
      if (user) {
        const raw = await this.verificationTokenService.issue(
          user,
          VerificationTokenType.PASSWORD_RESET,
        );
        await this.mailService.sendPasswordReset(user.email, raw);
        req.log.info("password reset requested", { userId: user.id });
      }
      res.status(202).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  async resetPassword(
    req: ResetPasswordRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const record = await this.verificationTokenService.consume(
        req.body.token,
        VerificationTokenType.PASSWORD_RESET,
      );
      if (!record) {
        return next(
          createHttpError(400, "Reset token is invalid, used or expired"),
        );
      }

      await this.userService.setPassword(record.userId, req.body.password);
      // A password change must not leave old sessions alive - that is the whole
      // point of resetting it after a suspected compromise.
      await this.tokenService.revokeAllForUser(record.userId);
      clearAuthCookies(res);

      req.log.info("password reset completed", { userId: record.userId });
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  async verifyEmail(req: TokenRequest, res: Response, next: NextFunction) {
    try {
      const record = await this.verificationTokenService.consume(
        req.body.token,
        VerificationTokenType.EMAIL_VERIFICATION,
      );
      if (!record) {
        return next(
          createHttpError(
            400,
            "Verification token is invalid, used or expired",
          ),
        );
      }
      await this.userService.markEmailVerified(record.userId);
      req.log.info("email verified", { userId: record.userId });
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  async resendVerification(
    req: ForgotPasswordRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const user = await this.userService.findByEmail(req.body.email);
      if (user && !user.emailVerified) {
        await this.sendVerificationEmail(user, req);
      }
      res.status(202).json({ success: true });
    } catch (err) {
      next(err);
    }
  }

  /**
   * A mail outage must not fail a registration that already succeeded, so the
   * failure is logged and swallowed. `POST /auth/resend-verification` is the
   * recovery path.
   */
  private async sendVerificationEmail(user: User, req: Request) {
    try {
      const raw = await this.verificationTokenService.issue(
        user,
        VerificationTokenType.EMAIL_VERIFICATION,
      );
      await this.mailService.sendEmailVerification(user.email, raw);
    } catch (err) {
      req.log.error("failed to send verification email", {
        userId: user.id,
        message: (err as Error).message,
      });
    }
  }
}
