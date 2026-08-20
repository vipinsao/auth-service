import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { tokenService, userController } from "../container.js";
import { authenticate } from "../middlewares/authenticate.js";
import { requireRole } from "../middlewares/requireRole.js";
import { Roles } from "../constants/index.js";

const router = express.Router();

/** Demonstrates the RBAC pair: authenticate first, then check the role. */
router.get(
  "/",
  authenticate(tokenService),
  requireRole(Roles.ADMIN),
  (req: Request, res: Response, next: NextFunction) =>
    userController.list(req, res, next),
);

export default router;
