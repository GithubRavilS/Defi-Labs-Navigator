/**
 * Печатает однострочный JSON для Vercel → GOOGLE_SERVICE_ACCOUNT_JSON
 * node scripts/print-vercel-google-env.mjs
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const credPath = path.join(root, "pusher-490008-bf7c384ba372.json");
const cred = JSON.parse(readFileSync(credPath, "utf8"));

console.log("Name: GOOGLE_SERVICE_ACCOUNT_JSON");
console.log("Email для доступа к таблице:", cred.client_email);
console.log("--- copy everything below this line ---");
console.log(JSON.stringify(cred));
