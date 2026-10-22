import { agentContractDocument } from './document.generated.js';
import type { AgentContractName, AgentContractTypes } from './generated.js';
import * as structuralValidators from './validator.generated.js';

export * from './generated.js';
export { agentContractDocument } from './document.generated.js';
export { agentContractOperations } from './operations.generated.js';

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  oneOf?: readonly JsonSchema[];
  allOf?: readonly JsonSchema[];
  'x-semantic-maximum'?: string;
}

const definitions = agentContractDocument.$defs as unknown as Record<string, JsonSchema>;
const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// In Unicode mode valid surrogate pairs form a single astral code point; this
// range therefore matches only isolated UTF-16 surrogate code units.
const loneSurrogate = /[\uD800-\uDFFF]/u;

/** Validates public JSON structure and scalar semantics without coercion or mutation.
 * Database ownership, idempotency, ordered-event merging and business permissions
 * remain the responsibility of the corresponding service/client state machines.
 * Use this facade rather than TypeBox Value.Check: the source uses exact oneOf,
 * dependentRequired and Unicode code-point lengths, plus bigint/date semantics.
 */
export function validateAgentContract<K extends AgentContractName>(
  name: K,
  value: unknown,
): value is AgentContractTypes[K] {
  if (!wellFormedJson(value) || !structuralValidators[name](value)) return false;
  return semanticCheck(definitions[name]!, value, name);
}

function wellFormedJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (typeof value === 'string') return !loneSurrogate.test(value);
  if (value === null || typeof value !== 'object') {
    return (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    );
  }
  if (!Array.isArray(value) && ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
    return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((entry) => wellFormedJson(entry, ancestors))
    : Object.entries(value).every(
        ([key, entry]) => !loneSurrogate.test(key) && wellFormedJson(entry, ancestors),
      );
  ancestors.delete(value);
  return valid;
}

function calendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!;
}

function timestamp(value: string): boolean {
  const match =
    /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match || !calendarDate(match[1]!)) return false;
  // RFC 3339 permits 60 only for a leap second at a UTC day boundary. The
  // contract's persisted product timestamps are canonical ordinary instants.
  // Accept syntactically valid leap seconds too, with the UTC boundary checked.
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHours = Number(match[7] ?? 0);
  const offsetMinutes = Number(match[8] ?? 0);
  if (hour > 23 || minute > 59 || second > 60 || offsetHours > 23 || offsetMinutes > 59)
    return false;
  if (second < 60) return true;
  const sign = match[6] === '-' ? -1 : 1;
  const utcMinute =
    (((hour * 60 + minute - sign * (offsetHours * 60 + offsetMinutes)) % 1440) + 1440) % 1440;
  return utcMinute === 1439;
}

function knownTimezone(value: string): boolean {
  // Intl also accepts numeric offsets on newer runtimes; those are not IANA
  // identifiers. Reject offsets explicitly while allowing UTC and IANA aliases.
  if (/^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function branchMatches(schema: JsonSchema, value: unknown): boolean {
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1) as AgentContractName;
    return structuralValidators[name](value);
  }
  if ('const' in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'integer') return Number.isInteger(value);
  if (schema.type) return typeof value === schema.type;
  return true;
}

function semanticCheck(schema: JsonSchema, value: unknown, name?: string): boolean {
  if (schema.$ref) {
    const reference = schema.$ref.split('/').at(-1)!;
    return semanticCheck(definitions[reference]!, value, reference);
  }
  if (schema.oneOf) {
    const branch = schema.oneOf.find((candidate) => branchMatches(candidate, value));
    if (!branch || !semanticCheck(branch, value)) return false;
  }
  if (schema.allOf && !schema.allOf.every((part) => semanticCheck(part, value))) return false;
  if (typeof value === 'string') {
    if (
      schema['x-semantic-maximum'] &&
      (value.length > 19 || BigInt(value) > BigInt(schema['x-semantic-maximum']))
    )
      return false;
    if (schema.format === 'date' && !calendarDate(value)) return false;
    if (schema.format === 'date-time' && !timestamp(value)) return false;
    if (schema.format === 'uuid' && !uuid.test(value)) return false;
  }
  if (Array.isArray(value) && schema.items) {
    return value.every((entry) => semanticCheck(schema.items!, entry));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    if (name === 'AttemptBudgetView') {
      if (
        (object.limit_exceeded_kind === null) !== (object.limit_exceeded_at === null) ||
        Number(object.model_requests_used) > Number(object.max_model_requests) ||
        Number(object.tool_calls_used) > Number(object.max_tool_calls)
      )
        return false;
    }
    if (name === 'DateRange' && String(object.end) < String(object.start)) return false;
    if (
      name === 'BusinessContext' &&
      typeof object.timezone === 'string' &&
      !knownTimezone(object.timezone)
    )
      return false;
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, key) && !semanticCheck(child, object[key])) return false;
    }
  }
  return true;
}
