import { checkSchema } from "express-validator";

/** Shared by forgot-password and resend-verification. */
export default checkSchema({
  email: {
    errorMessage: "Email is required",
    notEmpty: true,
    trim: true,
    isEmail: { errorMessage: "Email should be a valid email" },
  },
});
