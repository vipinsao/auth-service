import type { NextFunction, Request, Response } from "express";
import { UserService } from "../services/UserService.js";

export class UserController {
  constructor(private userService: UserService) {}

  /** Admin-only listing. Password hashes are excluded by the repository select. */
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const users = await this.userService.findAll();
      res.status(200).json({ users });
    } catch (err) {
      next(err);
    }
  }
}
