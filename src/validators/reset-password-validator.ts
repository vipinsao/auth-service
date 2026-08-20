import { checkSchema } from "express-validator";

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
  password: {
    trim: true,
    errorMessage: "Password is required",
    notEmpty: true,
    isLength: {
      options: { min: 8, max: 128 },
      errorMessage: "Password must be between 8 and 128 characters long",
    },
  },
});
