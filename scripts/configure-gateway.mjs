// Administrator-only helper; the bearer token never enters guest .env or output.
import fs from "fs";
import http from "http";
const entries = fs.readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/);
const line = entries.find((item) => item.startsWith("AGENT_COMPOSE_AUTH_TOKEN="));
const token = line ? line.slice(line.indexOf("=") + 1).trim() : "";
if (!token) throw new Error("Configure AGENT_COMPOSE_AUTH_TOKEN locally first");
const capsetLine = entries.find((item) => item.startsWith("OCTOBUS_TRIAGE_READ_TOKEN="));
const capsetToken = capsetLine ? capsetLine.slice(capsetLine.indexOf("=") + 1).trim() : "";
if (!capsetToken || capsetToken.startsWith("replace-with-")) {
  throw new Error("Configure OCTOBUS_TRIAGE_READ_TOKEN with a real triage-read scoped token first");
}
if (capsetToken === token) throw new Error("OCTOBUS_TRIAGE_READ_TOKEN must not reuse AGENT_COMPOSE_AUTH_TOKEN");
const payload = JSON.stringify({ addr: process.env.OCTOBUS_GATEWAY_ADDR || "http://octobus:9000", token: capsetToken });
const req = http.request("http://127.0.0.1:7410/agentcompose.v2.SettingsService/UpdateCapabilityGatewayConfig", {
  method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }
}, (res) => {
  res.resume();
  res.on("end", () => {
    if (res.statusCode !== 200) { console.error("Gateway configuration failed: HTTP " + res.statusCode); process.exitCode = 1; }
    else console.log("Capability Gateway configured with the triage-read scoped token; token value was not printed.");
  });
});
req.setTimeout(10000, () => req.destroy(new Error("Gateway configuration timeout")));
req.on("error", () => { console.error("Gateway configuration connection failed"); process.exitCode = 1; });
req.end(payload);
