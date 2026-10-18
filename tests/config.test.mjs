import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const compose = fs.readFileSync(new URL("../agent-compose.yml", import.meta.url), "utf8");

test("agent-compose configuration grants only the read capset", () => {
  assert.match(compose, /\- triage-read/);
  assert.doesNotMatch(compose, /triage-human-write/);
  assert.doesNotMatch(compose, /CreateDisposition/);
  assert.match(compose, /default: deny/);
  assert.match(compose, /concurrency_policy: skip/);
  assert.match(compose, /run_timeout: 10m/);
  assert.match(compose, /model: deepseek-v4-flash/);
  assert.match(compose, /Process one alert/);
  assert.doesNotMatch(compose, /matching agent\/output-schema/);
  assert.doesNotMatch(compose, /port: (9000|8080|8081)/);
});

test("credential files keep runtime secrets out of the tracked template", () => {
  const ignore = fs.readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  const init = fs.readFileSync(new URL("../scripts/init-env.mjs", import.meta.url), "utf8");
  const model = fs.readFileSync(new URL("../scripts/configure-model.py", import.meta.url), "utf8");
  const gateway = fs.readFileSync(new URL("../scripts/configure-gateway.mjs", import.meta.url), "utf8");
  const deployment = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.env\.\*$/m);
  assert.match(ignore, /^!\.env\.example$/m);
  assert.match(init, /new URL\("\.\.\/\.env", import\.meta\.url\)/);
  assert.match(init, /new URL\("\.\.\/\.env\.example", import\.meta\.url\)/);
  assert.match(model, /parent\.parent \/ "\.env"/);
  assert.match(gateway, /new URL\("\.\.\/\.env", import\.meta\.url\)/);
  assert.match(gateway, /OCTOBUS_TRIAGE_READ_TOKEN/);
  assert.match(gateway, /token: capsetToken/);
  assert.doesNotMatch(gateway, /token: ""/);
  assert.match(gateway, /replace-with-/);
  assert.match(deployment, /set OCTOBUS_ADMIN_TOKEN in \.env\}/);
  assert.match(deployment, /set AGENT_COMPOSE_AUTH_TOKEN in \.env\}/);
});

test("deployment separates sandbox network and requires daemon authentication", () => {
  const deployment = fs.readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  assert.match(deployment, /internal: true/);
  assert.match(deployment, /AGENT_COMPOSE_AUTH_TOKEN: \$\{AGENT_COMPOSE_AUTH_TOKEN:\?/);
  assert.match(deployment, /CAP_GRPC_TARGET: agent-compose:7411/);
  assert.match(deployment, /EGRESS_UNENFORCEABLE_POLICY: refuse/);
  assert.doesNotMatch(deployment, /\.env:.*\/data/);
});

