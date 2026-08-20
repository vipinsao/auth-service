// Generates the RS256 key pair used to sign and verify access tokens.
// Run once per environment: npm run keys:generate
import crypto from "crypto";
import fs from "fs";
import path from "path";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "pkcs1", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const dir = path.resolve(process.cwd(), "certs");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "private.pem"), privateKey, { mode: 0o600 });
fs.writeFileSync(path.join(dir, "public.pem"), publicKey);

console.log(
  `Wrote ${path.join(dir, "private.pem")} and ${path.join(dir, "public.pem")}`,
);
console.log("certs/ is gitignored - never commit the private key.");
