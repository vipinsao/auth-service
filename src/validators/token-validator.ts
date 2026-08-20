import { checkSchema } from "express-validator";

/** Tokens are 32 random bytes rendered as 64 lowercase hex characters. */
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
});
