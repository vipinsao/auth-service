import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { authController, tokenService } from "../container.js";
import { validateRequest } from "../middlewares/validateRequest.js";
import { authenticate } from "../middlewares/authenticate.js";
import { authLimiter, refreshLimiter } from "../middlewares/rateLimiters.js";
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

// No validator: the only input is the refreshToken cookie, and the controller
// verifies its signature before it is used for anything.
router.post(
  "/refresh",
  refreshLimiter,
  (req: Request, res: Response, next: NextFunction) =>
    authController.refresh(req, res, next),
);

// Deliberately unlimited. Logout revokes rather than mints, an unusable cookie
// costs one signature check and no query, and refusing a logout leaves a
// session alive that the user asked to end - the wrong way for this to fail.
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
  authLimiter,
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
