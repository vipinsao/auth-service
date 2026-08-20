/**
 * Hand-written OpenAPI 3.1 description of every route this service exposes,
 * served by swagger-ui-express at /api-docs. It is written by hand rather than
 * generated from decorators so there is exactly one place to read the contract.
 */
const errorResponse = {
  type: "object",
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string" },
          msg: { type: "string" },
          path: { type: "string" },
          location: { type: "string" },
          requestId: { type: "string" },
        },
      },
    },
  },
};

const json = (schema: unknown) => ({ "application/json": { schema } });

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Auth Service API",
    version: "1.0.0",
    description:
      "Registration, login, refresh-token rotation with reuse detection, " +
      "password reset, email verification and role-based access control.",
  },
  servers: [{ url: "/", description: "This server" }],
  tags: [
    { name: "auth", description: "Credentials, sessions and tokens" },
    { name: "users", description: "Administrative user access" },
    { name: "ops", description: "Liveness and readiness" },
  ],
  components: {
    securitySchemes: {
      accessTokenCookie: {
        type: "apiKey",
        in: "cookie",
        name: "accessToken",
        description: "RS256 access token set as an httpOnly cookie on login.",
      },
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
      },
    },
    schemas: {
      Error: errorResponse,
      RegisterRequest: {
        type: "object",
        required: ["firstName", "lastName", "email", "password"],
        properties: {
          firstName: { type: "string", example: "Ada" },
          lastName: { type: "string", example: "Lovelace" },
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8, maxLength: 128 },
        },
      },
      LoginRequest: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string" },
        },
      },
      Self: {
        type: "object",
        properties: {
          id: { type: "integer" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string" },
          role: { type: "string", enum: ["customer", "admin", "manager"] },
          emailVerified: { type: "boolean" },
          createdAt: { type: "string", format: "date-time" },
        },
      },
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["ops"],
        summary: "Liveness probe",
        responses: { "200": { description: "Process is up" } },
      },
    },
    "/ready": {
      get: {
        tags: ["ops"],
        summary: "Readiness probe (checks the database)",
        responses: {
          "200": { description: "Ready to serve traffic" },
          "503": { description: "Database unreachable" },
        },
      },
    },
    "/auth/register": {
      post: {
        tags: ["auth"],
        summary: "Create an account and start a session",
        description:
          "Hashes the password with bcrypt, assigns the `customer` role, sets " +
          "accessToken and refreshToken cookies and emails a verification link.",
        requestBody: {
          required: true,
          content: json({ $ref: "#/components/schemas/RegisterRequest" }),
        },
        responses: {
          "201": {
            description: "Created",
            content: json({
              type: "object",
              properties: { userId: { type: "integer" } },
            }),
          },
          "400": {
            description: "Validation failed or email already registered",
            content: json({ $ref: "#/components/schemas/Error" }),
          },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["auth"],
        summary: "Exchange credentials for a session",
        requestBody: {
          required: true,
          content: json({ $ref: "#/components/schemas/LoginRequest" }),
        },
        responses: {
          "200": {
            description: "Authenticated; cookies set",
            content: json({
              type: "object",
              properties: { id: { type: "integer" } },
            }),
          },
          "400": { description: "Email or password does not match" },
          "403": { description: "Email address is not verified" },
          "423": { description: "Account locked after repeated failures" },
          "429": { description: "Rate limited" },
        },
      },
    },
    "/auth/refresh": {
      post: {
        tags: ["auth"],
        summary: "Rotate the refresh token",
        description:
          "Burns the presented refresh token and issues its successor in the " +
          "same family. Presenting an already-rotated token revokes the whole " +
          "family and returns 401.",
        responses: {
          "200": { description: "New cookies issued" },
          "401": { description: "Missing, invalid, expired or replayed token" },
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["auth"],
        summary: "Revoke the current token family and clear cookies",
        responses: { "200": { description: "Logged out" } },
      },
    },
    "/auth/self": {
      get: {
        tags: ["auth"],
        summary: "The authenticated user",
        security: [{ accessTokenCookie: [] }, { bearerAuth: [] }],
        responses: {
          "200": {
            description: "Current user",
            content: json({ $ref: "#/components/schemas/Self" }),
          },
          "401": { description: "Missing or invalid access token" },
        },
      },
    },
    "/auth/forgot-password": {
      post: {
        tags: ["auth"],
        summary: "Email a single-use password reset link",
        description:
          "Always answers 202, whether or not the address exists, so the " +
          "endpoint cannot be used to enumerate accounts.",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } },
          }),
        },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/auth/reset-password": {
      post: {
        tags: ["auth"],
        summary: "Set a new password using a reset token",
        description:
          "Consumes the token, replaces the password hash and revokes every " +
          "refresh token the user holds.",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["token", "password"],
            properties: {
              token: { type: "string", pattern: "^[a-f0-9]{64}$" },
              password: { type: "string", minLength: 8 },
            },
          }),
        },
        responses: {
          "200": { description: "Password changed" },
          "400": { description: "Token invalid, already used or expired" },
        },
      },
    },
    "/auth/verify-email": {
      post: {
        tags: ["auth"],
        summary: "Confirm an email address",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["token"],
            properties: {
              token: { type: "string", pattern: "^[a-f0-9]{64}$" },
            },
          }),
        },
        responses: {
          "200": { description: "Verified" },
          "400": { description: "Token invalid, already used or expired" },
        },
      },
    },
    "/auth/resend-verification": {
      post: {
        tags: ["auth"],
        summary: "Send a fresh verification email",
        requestBody: {
          required: true,
          content: json({
            type: "object",
            required: ["email"],
            properties: { email: { type: "string", format: "email" } },
          }),
        },
        responses: { "202": { description: "Accepted" } },
      },
    },
    "/users": {
      get: {
        tags: ["users"],
        summary: "List all users (admin only)",
        security: [{ accessTokenCookie: [] }, { bearerAuth: [] }],
        responses: {
          "200": { description: "User list" },
          "401": { description: "Not authenticated" },
          "403": { description: "Authenticated but not an admin" },
        },
      },
    },
  },
};
