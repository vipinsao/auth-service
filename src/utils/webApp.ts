import fs from "fs";
import path from "path";
import express, { type Express } from "express";

/**
 * Serves the demo UI's production build (`web/dist`) from the same origin as
 * the API.
 *
 * Same origin is the point: it lets the auth cookies stay `httpOnly` and
 * `sameSite: strict` with no CORS exception for the browser app. A UI on
 * another domain would need `sameSite: none` cookies and a credentialed CORS
 * allow-list, which is a weaker setup to demonstrate an auth service with.
 *
 * Mounts nothing and returns false when there is no build, so the API behaves
 * exactly the same with or without the UI (the test suite never builds it).
 */
export const mountWebApp = (app: Express, distDir: string): boolean => {
  if (!fs.existsSync(path.join(distDir, "index.html"))) return false;

  app.use(
    express.static(distDir, {
      // Vite fingerprints everything under assets/, so those can be cached;
      // index.html is what points at the current fingerprints, so it must not
      // be, or a deploy leaves browsers loading the previous build.
      setHeaders: (res, filePath) => {
        res.setHeader(
          "Cache-Control",
          path.basename(filePath) === "index.html"
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        );
      },
    }),
  );
  return true;
};
