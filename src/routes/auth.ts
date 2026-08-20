import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { authController, tokenService } from "../container.js";
import { validateRequest } from "../middlewares/validateRequest.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authLimiter } from "../middlewares/rateLimiters.js";
import registerValidator from "../validators/register-validator.js";
import loginValidator from "../validators/login-validator.js";
import emailValidator from "../validators/email-validator.js";
import tokenValidator from "../validators/token-validator.js";
import resetPasswordValidator from "../validators/reset-password-validator.js";

const router = express.Router();

router.post(
  "/register",
  authLimiter,
  registerValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.register(req, res, next),
);

router.post(
  "/login",
  authLimiter,
  loginValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.login(req, res, next),
);

router.post("/refresh", (req: Request, res: Response, next: NextFunction) =>
  authController.refresh(req, res, next),
);

router.post("/logout", (req: Request, res: Response, next: NextFunction) =>
  authController.logout(req, res, next),
);

router.get(
  "/self",
  authenticate(tokenService),
  (req: Request, res: Response, next: NextFunction) =>
    authController.self(req, res, next),
);

router.post(
  "/forgot-password",
  authLimiter,
  emailValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.forgotPassword(req, res, next),
);

router.post(
  "/reset-password",
  authLimiter,
  resetPasswordValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.resetPassword(req, res, next),
);

router.post(
  "/verify-email",
  tokenValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.verifyEmail(req, res, next),
);

router.post(
  "/resend-verification",
  authLimiter,
  emailValidator,
  validateRequest,
  (req: Request, res: Response, next: NextFunction) =>
    authController.resendVerification(req, res, next),
);

export default router;
