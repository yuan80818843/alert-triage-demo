// Generate local demo control-plane credentials without printing them.
// Never overwrite an existing .env (in particular a deployed server config).
import fs from "fs";
import crypto from "crypto";
const target = new URL("../.env", import.meta.url);
const sample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
const octobusToken = crypto.randomBytes(32).toString("hex");
const daemonToken = crypto.randomBytes(32).toString("hex");
const content = sample
  .replaceAll("replace-with-local-demo-token", octobusToken)
  .replaceAll("replace-with-a-separate-random-daemon-token", daemonToken);
fs.writeFileSync(target, content, { flag: "wx", mode: 0o600 });
console.log("Created .env with independent random demo credentials; values were not printed.");
