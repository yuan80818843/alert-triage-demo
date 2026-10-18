import { defineService, GrpcError } from "@chaitin-ai/octobus-sdk";
import { handlers } from "./alert-platform.js";

const codes = { INVALID_ARGUMENT: 3, DEADLINE_EXCEEDED: 4, NOT_FOUND: 5, FAILED_PRECONDITION: 9, UNAVAILABLE: 14 };
const rpcHandlers = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, async (ctx) => {
  try { return await handler(ctx); }
  catch (error) {
    // Use the public SDK error type; a plain Error with a code property is
    // serialized by the SDK as INTERNAL, losing validation error semantics.
    if (codes[error.code]) throw new GrpcError(codes[error.code], error.message);
    throw error;
  }
}]));

export const service = defineService({ handlers: rpcHandlers });

