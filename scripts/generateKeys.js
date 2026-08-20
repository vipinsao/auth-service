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

const privateKeyPath = path.join(dir, "private.pem");
fs.writeFileSync(privateKeyPath, privateKey, { mode: 0o600 });
// `mode` on writeFileSync only applies when the file is created. Regenerating
// over an existing key kept whatever permissions were already there, so a key
// that had once been 0644 stayed 0644 - readable by every account on the box.
// chmod makes the permission a property of the file rather than of how it
// happened to be made.
fs.chmodSync(privateKeyPath, 0o600);

fs.writeFileSync(path.join(dir, "public.pem"), publicKey);

console.log(
  `Wrote ${path.join(dir, "private.pem")} and ${path.join(dir, "public.pem")}`,
);
console.log("certs/ is gitignored - never commit the private key.");
