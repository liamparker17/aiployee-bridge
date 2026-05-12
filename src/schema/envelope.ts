import { z } from "zod";

// Every AIployee API response is wrapped. Validation failures return
// HTTP 200 with success:false — the bridge must treat success===true as
// the gate, not the HTTP status.
export const Envelope = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({
    code: z.number(),
    success: z.boolean(),
    errors: z.unknown().nullable(),
    result: payload.nullable(),
  });

export type Envelope<T> = {
  code: number;
  success: boolean;
  errors: unknown | null;
  result: T | null;
};

// Thrown when success===false, or when the HTTP status indicates a
// transport-layer failure. Preserves the original envelope so callers
// can inspect node-level error details.
export class ApiError extends Error {
  readonly httpStatus: number;
  readonly code: number;
  readonly errors: unknown;
  readonly endpoint: string;

  constructor(opts: {
    message: string;
    endpoint: string;
    httpStatus: number;
    code: number;
    errors: unknown;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.endpoint = opts.endpoint;
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
    this.errors = opts.errors;
  }
}
