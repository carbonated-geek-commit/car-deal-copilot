/**
 * Request validation (docs/design/T-019.md §2.8, §4.2 step 4; AC-5).
 *
 * Registered as `preValidation`, which Fastify runs strictly before every
 * `preHandler` — therefore before the deal gate, and therefore before any code
 * that could hold a `DealHandle` and reach the store. "Validation rejects
 * malformed or out-of-enum input before any repository call" is a consequence
 * of the lifecycle position, not of handler discipline.
 *
 * On success the parsed values REPLACE `req.params` / `req.query` / `req.body`.
 * A handler that reads them therefore cannot accidentally read a raw one, and
 * the parsed value is the coerced, `.strict()`-checked object rather than
 * whatever arrived on the wire.
 *
 * Rejections are THROWN as `ApiErrorException` rather than sent from here.
 * Sending would put a second response-rendering site in the service; throwing
 * routes every failure through the single `setErrorHandler` that owns the
 * envelope (D4).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';

import { ApiErrorException } from '../errors/envelope.js';
import { fromZodError, type ValidationRoot } from '../errors/mapping.js';
import { markHook } from '../http/marks.js';

export interface ValidationSpec {
  readonly params?: ZodType;
  readonly query?: ZodType;
  readonly body?: ZodType;
}

/**
 * Order is params → query → body, and it is deliberate: params identify the
 * resource the gate is about to authorize, so a malformed `:deal_id` is
 * reported as the malformed thing it is rather than buried under body issues
 * for a resource that was never addressable.
 *
 * Only the FIRST failing root is reported. Reporting all three would describe
 * a body schema to a caller who has not yet produced a well-formed path.
 */
export function validate(spec: ValidationSpec): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const roots: readonly (readonly [ValidationRoot, ZodType | undefined])[] = [
    ['params', spec.params],
    ['query', spec.query],
    ['body', spec.body],
  ];

  return markHook(async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const mutable = req as unknown as Record<ValidationRoot, unknown>;
    for (const [root, schema] of roots) {
      if (schema === undefined) continue;
      const parsed = schema.safeParse(mutable[root]);
      if (!parsed.success) {
        throw new ApiErrorException(fromZodError(parsed.error.issues, root));
      }
      mutable[root] = parsed.data;
    }
  }, 'validation');
}

/**
 * The validated value, read back with the schema's inferred type.
 *
 * Exists so a handler never writes `req.params as { deal_id: string }` — a cast
 * is exactly how an unvalidated route starts looking like a validated one.
 */
export function validated<T>(req: FastifyRequest, root: ValidationRoot): T {
  return (req as unknown as Record<ValidationRoot, unknown>)[root] as T;
}
