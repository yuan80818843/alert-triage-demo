export function fail(code, message) {
  const error = new Error(message); error.code = code; throw error;
}

export function value(request, ...names) {
  for (const name of names) if (request?.[name] !== undefined && request[name] !== null && request[name] !== "") return request[name];
  return undefined;
}

// RFC3339 with calendar checks: Date.parse alone normalizes invalid Feb dates.
export function isoMillis(input) {
  if (typeof input !== "string") return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) return NaN;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) return NaN;
  if (match[7] !== "Z" && (Number(match[7].slice(1, 3)) > 23 || Number(match[7].slice(4, 6)) > 59)) return NaN;
  return Date.parse(input);
}

export function parseTime(input, field) {
  if (input === undefined || input === "") return undefined;
  const time = isoMillis(input);
  if (!Number.isFinite(time)) fail("INVALID_ARGUMENT", `${field} must be an RFC3339 timestamp`);
  return new Date(time).toISOString();
}

export function parseRange(request) {
  const start = parseTime(value(request, "start_time", "startTime"), "start_time");
  const end = parseTime(value(request, "end_time", "endTime"), "end_time");
  if (start && end && start > end) fail("INVALID_ARGUMENT", "start_time must not exceed end_time");
  return { start, end };
}

export function pageSize(input, max = 20) {
  const parsed = input === undefined || input === 0 ? Math.min(20, max) : input;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > max) fail("INVALID_ARGUMENT", `page_size must be an integer from 1 to ${max}`);
  return parsed;
}

export function confidence(input) {
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || input > 1) fail("INVALID_ARGUMENT", "confidence must be a number between 0 and 1");
  return input;
}

export function assertString(request, field, ...aliases) {
  const result = value(request, field, ...aliases);
  if (typeof result !== "string" || !result.trim() || result.length > 256) fail("INVALID_ARGUMENT", `${field} is required (max 256 characters)`);
  return result.trim();
}

export function stringArray(input, field) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 100 || input.some((item) => typeof item !== "string" || !item.trim() || item.length > 256)) fail("INVALID_ARGUMENT", `${field} must contain at most 100 nonempty strings`);
  return [...new Set(input)];
}
