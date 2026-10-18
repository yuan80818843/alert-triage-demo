import fs from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";

export function validRunId(id) { return typeof id === "string" && /^[a-f0-9]{64}$/.test(id); }

function removeTree(location) {
  if (fs.rmSync) fs.rmSync(location, { recursive: true, force: true });
  else {
    try { fs.rmdirSync(location, { recursive: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

// Atomic, no-clobber commits make replays and concurrent observers idempotent.
// Reports are immutable: a rejected run requires a new run, not silent repair.
export class ReportStore {
  constructor(directory) { this.directory = directory; }

  evidenceLockLocation(alertId, evidenceIds) {
    if (typeof alertId !== "string" || !alertId || !Array.isArray(evidenceIds)) throw new Error("Invalid evidence lock key");
    const normalized = [...new Set(evidenceIds)].filter((id) => typeof id === "string" && id).sort();
    const key = createHash("sha256").update(JSON.stringify([alertId, normalized])).digest("hex");
    return path.join(this.directory, ".locks", key + ".lock");
  }

  async withEvidenceLock(alertId, evidenceIds, callback, options = {}) {
    if (typeof callback !== "function") throw new Error("Evidence lock callback is required");
    const lockDirectory = this.evidenceLockLocation(alertId, evidenceIds);
    const staleMs = Number.isInteger(options.staleMs) ? options.staleMs : 30000;
    const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 5000;
    const retryMs = Number.isInteger(options.retryMs) ? options.retryMs : 10;
    if (staleMs < 100 || timeoutMs < 0 || retryMs < 1) throw new Error("Invalid evidence lock options");
    fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });
    const token = randomBytes(16).toString("hex");
    const ownerPath = path.join(lockDirectory, "owner.json");
    const started = Date.now();
    let acquired = false;
    while (!acquired) {
      try {
        fs.mkdirSync(lockDirectory, { mode: 0o700 });
        fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token, acquired_at: new Date().toISOString() }) + "\n", { flag: "wx", mode: 0o600 });
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") {
          try { removeTree(lockDirectory); } catch (_) { /* preserve the acquisition error */ }
          throw error;
        }
        let stale = false;
        try { stale = Date.now() - fs.statSync(lockDirectory).mtimeMs > staleMs; }
        catch (statError) { if (statError.code !== "ENOENT") throw statError; }
        if (stale) {
          try { removeTree(lockDirectory); }
          catch (removeError) { if (removeError.code !== "ENOENT") throw removeError; }
          continue;
        }
        if (Date.now() - started >= timeoutMs) {
          const lockError = new Error("Evidence lock unavailable");
          lockError.code = "LOCK_TIMEOUT";
          throw lockError;
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
    const heartbeatMs = Math.max(1000, Math.floor(staleMs / 3));
    const heartbeat = setInterval(() => {
      try { fs.utimesSync(lockDirectory, new Date(), new Date()); } catch (_) { /* owner cleanup or stale recovery won the race */ }
    }, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();
    try { return await callback(); }
    finally {
      clearInterval(heartbeat);
      try {
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        if (owner.token === token) removeTree(lockDirectory);
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }

  location(id, scheduler = false) {
    if (!validRunId(id)) throw new Error("Invalid platform ID");
    return path.join(this.directory, scheduler ? "scheduler" : "", id + ".json");
  }

  get(id, scheduler = false) {
    try { return JSON.parse(fs.readFileSync(this.location(id, scheduler), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  findAcceptedByEvidence(alertId, evidenceIds, excludeRunId = "") {
    if (typeof alertId !== "string" || !alertId || !Array.isArray(evidenceIds)) return null;
    const expected = [...new Set(evidenceIds)].sort().join("\u0000");
    let entries = [];
    try { entries = fs.readdirSync(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const runId = entry.name.slice(0, -5);
      if (!validRunId(runId) || runId === excludeRunId) continue;
      let artifact;
      try { artifact = JSON.parse(fs.readFileSync(path.join(this.directory, entry.name), "utf8")); }
      catch (_) { continue; }
      const report = artifact && artifact.report;
      if (!artifact || !artifact.accepted || !report || report.alert_id !== alertId || !Array.isArray(report.evidence_chain)) continue;
      const actual = [...new Set(report.evidence_chain.map((item) => item && item.evidence_id).filter((id) => typeof id === "string"))].sort().join("\u0000");
      if (actual === expected) return { run_id: runId, artifact };
    }
    return null;
  }

  put(id, artifact, scheduler = false) {
    const target = this.location(id, scheduler);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const pending = target + "." + randomBytes(8).toString("hex") + ".pending";
    fs.writeFileSync(pending, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(pending, target);
      return { created: true, artifact };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { created: false, artifact: this.get(id, scheduler) };
    } finally { fs.unlinkSync(pending); }
  }
}
