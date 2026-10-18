import http from "http";
import { execFileSync } from "child_process";

export class ReceiverUnavailable extends Error {
  constructor() { super("PLATFORM_READ_UNAVAILABLE"); this.code = "PLATFORM_READ_UNAVAILABLE"; }
}

export function createPlatformClient(config) {
  function cli(container, args) {
    try {
      const command = config.dockerDirect ? "docker" : "sudo";
      const prefix = config.dockerDirect ? [] : ["-n", "docker"];
      return execFileSync(command, prefix.concat(["exec", container], args), {
        encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 20000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (_) { throw new ReceiverUnavailable(); }
  }

  function agent(args) {
    try { return JSON.parse(cli(config.daemonContainer, ["/app/agent-compose"].concat(args, ["--json"]))); }
    catch (_) { throw new ReceiverUnavailable(); }
  }

  function rpc(method, request) {
    const url = new URL("/capsets/triage-read/connect/alert-platform-demo/alert_triage.v1.AlertPlatformService/" + method, config.gateway);
    const headers = { "content-type": "application/json" };
    if (config.capsetToken) headers.authorization = "Bearer " + config.capsetToken;
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: "POST", headers }, (res) => {
        let data = "";
        res.on("data", (part) => { data += part; if (data.length > 2 * 1024 * 1024) res.destroy(new ReceiverUnavailable()); });
        res.on("error", () => reject(new ReceiverUnavailable()));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new ReceiverUnavailable());
          try { resolve(JSON.parse(data)); } catch (_) { reject(new ReceiverUnavailable()); }
        });
      });
      req.setTimeout(10000, () => req.destroy(new ReceiverUnavailable()));
      req.on("error", () => reject(new ReceiverUnavailable()));
      req.end(JSON.stringify(request));
    });
  }

  return {
    inspect: (id) => agent(["inspect", id]),
    list: () => agent(["scheduler", "runs", config.scheduler, "--limit", String(config.batchLimit)]).runs,
    rpc,
    audit: () => {
      try {
        return cli(config.octobusContainer, ["octobus", "logs", "--capset", "triage-read", "--tail", String(config.auditTail)])
          .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      } catch (_) { throw new ReceiverUnavailable(); }
    },
  };
}
