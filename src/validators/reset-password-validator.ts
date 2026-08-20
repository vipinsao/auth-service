import { checkSchema } from "express-validator";
import { passwordSchema } from "./password-rules.js";

export default checkSchema({
  token: {
    errorMessage: "Token is required",
    notEmpty: true,
    trim: true,
    matches: {
      options: /^[a-f0-9]{64}$/,
      errorMessage: "Token is malformed",
    },
  },
  password: passwordSchema,
});
