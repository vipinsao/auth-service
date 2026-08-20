import { checkSchema } from "express-validator";

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
