import { checkSchema } from "express-validator";
import { passwordSchema } from "./password-rules.js";

export default checkSchema({
  email: {
    errorMessage: "Email is required",
    notEmpty: true,
    trim: true,
    isEmail: { errorMessage: "Email should be a valid email" },
    normalizeEmail: false,
  },
  firstName: {
    errorMessage: "FirstName is required",
    notEmpty: true,
    trim: true,
    isLength: { options: { max: 100 } },
  },
  lastName: {
    errorMessage: "LastName is required",
    notEmpty: true,
    trim: true,
    isLength: { options: { max: 100 } },
  },
  password: passwordSchema,
});
