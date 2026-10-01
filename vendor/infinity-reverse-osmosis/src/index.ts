export type JSONValue =
  | null
  | boolean
  | number
  | string
  | readonly JSONValue[]
  | { readonly [key: string]: JSONValue };
export type Direction = "social-to-native" | "native-to-social";
export interface Scope {
  readonly product: string;
  readonly businessId: string;
  readonly ownerId: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly provider: string;
  readonly accountId: string;
}
export interface ProposalInput {
  readonly scope: Scope;
  readonly direction: Direction;
  readonly eventId: string;
  readonly sourceVersion: string;
  readonly expectedNativeVersion: string;
  readonly fields: Readonly<Record<string, JSONValue>>;
  readonly causalProvenance?: string;
}
export interface Proposal extends ProposalInput {
  readonly businessBindingRevision: string;
  readonly payloadDigest: string;
  readonly operationKey: string;
}
export interface ExactApproval {
  readonly scope: Scope;
  readonly direction: Direction;
  readonly eventId: string;
  readonly sourceVersion: string;
  readonly expectedNativeVersion: string;
  readonly payloadDigest: string;
  readonly businessBindingRevision: string;
  readonly approvalId: string;
}
/** Opaque native object. Only the native port may mint and validate these capabilities. */
export type NativeClaim = object;
export interface DurableOutcome {
  readonly operationKey: string;
  readonly payloadDigest: string;
  readonly status: "completed" | "denied" | "held" | "absent" | "reflected";
  readonly receipt?: JSONValue;
}
export interface ClaimRequest {
  readonly proposal: Proposal;
  readonly approval: ExactApproval;
}
export type ClaimResult =
  | { readonly kind: "claimed"; readonly claim: NativeClaim }
  | { readonly kind: "outcome"; readonly outcome: DurableOutcome };
export interface BusinessAssetEvidence {
  readonly scope: Scope;
  readonly assetKind: "business-page" | "business-account" | "business-channel";
  readonly providerVerified: true;
  readonly ownerAuthorized: true;
  readonly revoked: false;
  readonly expiresAt: number;
  readonly verifiedAt: number;
  readonly providerAssetId: string;
  readonly nativeBusinessId: string;
  readonly nativeSubjectId: string;
  readonly authorizedOwnerId: string;
  readonly bindingRevision: string;
}
export interface NativePort {
  verifyBusinessAsset(proposal: ProposalInput): Promise<BusinessAssetEvidence>;
  /** One native transaction: current consent/permissions, exact approval, CAS, payload collision and durable ownership. Replays must reauthorize disclosure. */
  authorizeAndClaim(request: ClaimRequest): Promise<ClaimResult>;
  /** Validate native-minted claim and fresh policy atomically with effect initiation. Never accept a caller boolean. Persist outcome. */
  executeClaimed(claim: NativeClaim): Promise<DurableOutcome>;
  /** Any unknown effect result must become a durable reconciliation hold, never a retryable failure. */
  holdUncertain(claim: NativeClaim): Promise<void>;
  /** Reauthorize every disclosure, including replay. */
  readOutcome(proposal: Proposal): Promise<DurableOutcome | undefined>;
  /** Owner verifies delivery or absence; only verified absence can release a hold for a separately authorized attempt. */
  reconcile(proposal: Proposal): Promise<DurableOutcome>;
  /** Verify matching causal provenance of a completed native operation. Caller origin labels are insufficient. */
  verifyReflection?(proposal: Proposal): Promise<boolean>;
}
export class ReverseOsmosisError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ReverseOsmosisError";
  }
}
export class UncertainEffectError extends ReverseOsmosisError {
  constructor(
    readonly operationKey: string,
    readonly holdPersisted: boolean,
  ) {
    super("effect-uncertain-reconciliation-required");
  }
}
const fail = (code: string): never => {
  throw new ReverseOsmosisError(code);
};
// Inspect descriptors before reading: no getters, custom prototypes, cycles, symbols or coercion.
function snapshot(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 0 },
): JSONValue {
  if (++budget.nodes > 4096 || depth > 16) fail("payload-limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > 16384) fail("payload-limit");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("unsafe-json");
    return value;
  }
  if (typeof value !== "object" || !value) return fail("unsafe-json");
  if (seen.has(value)) fail("unsafe-json");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype) &&
    Object.getPrototypeOf(value) !== null
  )
    fail("unsafe-json");
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length) fail("unsafe-json");
  const result: Record<string, JSONValue> = Object.create(null) as Record<
    string,
    JSONValue
  >;
  for (const key of Object.keys(descriptors).sort()) {
    if (array && key === "length") continue;
    if (key.length > 256) fail("payload-limit");
    if (["__proto__", "prototype", "constructor"].includes(key))
      fail("unsafe-json");
    const descriptor = descriptors[key]!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail("unsafe-json");
    result[key] = snapshot(descriptor.value, depth + 1, seen, budget);
  }
  seen.delete(value);
  if (array) {
    const length = (value as unknown[]).length;
    if (
      Object.keys(result).length !== length ||
      Object.keys(result).some(
        (k) => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length,
      )
    )
      fail("unsafe-json");
    return Object.freeze(Array.from({ length }, (_, i) => result[String(i)]!));
  }
  return Object.freeze(result);
}
function record(value: unknown): Record<string, JSONValue> {
  const result = snapshot(value);
  if (!result || typeof result !== "object" || Array.isArray(result))
    return fail("invalid-record");
  return result as Record<string, JSONValue>;
}
function exactKeys(
  value: Record<string, JSONValue>,
  keys: string[],
  optional: string[] = [],
) {
  if (
    Object.keys(value).some(
      (k) => !keys.includes(k) && !optional.includes(k),
    ) ||
    keys.some((k) => !(k in value))
  )
    fail("invalid-fields");
}
function str(value: JSONValue | undefined): string {
  if (typeof value !== "string" || !value || value.length > 512)
    return fail("invalid-identifier");
  return value;
}
function scope(value: unknown): Scope {
  const s = record(value);
  exactKeys(s, [
    "product",
    "businessId",
    "ownerId",
    "tenantId",
    "subjectId",
    "provider",
    "accountId",
  ]);
  return Object.freeze({
    product: str(s.product),
    businessId: str(s.businessId),
    ownerId: str(s.ownerId),
    tenantId: str(s.tenantId),
    subjectId: str(s.subjectId),
    provider: str(s.provider),
    accountId: str(s.accountId),
  });
}
function direction(value: JSONValue | undefined): Direction {
  if (value !== "social-to-native" && value !== "native-to-social")
    return fail("invalid-direction");
  return value;
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export function createReverseOsmosisEngine(port: NativePort) {
  async function outcome(value: unknown, p: Proposal): Promise<DurableOutcome> {
    const o = record(value);
    exactKeys(o, ["operationKey", "payloadDigest", "status"], ["receipt"]);
    if (
      o.operationKey !== p.operationKey ||
      o.payloadDigest !== p.payloadDigest ||
      typeof o.status !== "string" ||
      !["completed", "denied", "held", "absent", "reflected"].includes(o.status)
    )
      fail("outcome-mismatch");
    if (
      o.status === "reflected" &&
      (!port.verifyReflection || !(await port.verifyReflection(p)))
    )
      fail("unverified-reflection");
    return o as unknown as DurableOutcome;
  }
  async function businessAsset(p: ProposalInput): Promise<string> {
    const e = record(await port.verifyBusinessAsset(p));
    if (
      JSON.stringify(scope(e.scope)) !== JSON.stringify(p.scope) ||
      typeof e.assetKind !== "string" ||
      !["business-page", "business-account", "business-channel"].includes(
        e.assetKind,
      ) ||
      e.providerVerified !== true ||
      e.ownerAuthorized !== true ||
      e.revoked !== false ||
      typeof e.expiresAt !== "number" ||
      e.expiresAt <= Date.now() ||
      typeof e.verifiedAt !== "number" ||
      e.verifiedAt > Date.now() ||
      Date.now() - e.verifiedAt > 60000 ||
      e.providerAssetId !== p.scope.accountId ||
      e.nativeBusinessId !== p.scope.businessId ||
      e.nativeSubjectId !== p.scope.subjectId ||
      e.authorizedOwnerId !== p.scope.ownerId
    )
      fail("business-asset-required");
    return str(e.bindingRevision);
  }
  async function propose(input: ProposalInput): Promise<Proposal> {
    const p = record(input);
    exactKeys(
      p,
      [
        "scope",
        "direction",
        "eventId",
        "sourceVersion",
        "expectedNativeVersion",
        "fields",
      ],
      ["causalProvenance"],
    );
    const base: ProposalInput = Object.freeze({
      scope: scope(p.scope),
      direction: direction(p.direction),
      eventId: str(p.eventId),
      sourceVersion: str(p.sourceVersion),
      expectedNativeVersion: str(p.expectedNativeVersion),
      fields: record(p.fields),
      ...(p.causalProvenance === undefined
        ? {}
        : { causalProvenance: str(p.causalProvenance) }),
    });
    const businessBindingRevision = await businessAsset(base);
    const payloadDigest = await digest({ ...base, businessBindingRevision });
    const operationKey = await digest([
      base.scope,
      base.direction,
      base.eventId,
      base.sourceVersion,
    ]);
    return Object.freeze({
      ...base,
      businessBindingRevision,
      payloadDigest,
      operationKey,
    });
  }
  async function run(
    proposal: Proposal,
    approval: ExactApproval,
    expected: Direction,
  ): Promise<DurableOutcome> {
    // Both snapshots happen before the first asynchronous boundary.
    const p = record(proposal);
    exactKeys(
      p,
      [
        "scope",
        "direction",
        "eventId",
        "sourceVersion",
        "expectedNativeVersion",
        "fields",
        "businessBindingRevision",
        "payloadDigest",
        "operationKey",
      ],
      ["causalProvenance"],
    );
    const a = record(approval);
    exactKeys(a, [
      "scope",
      "direction",
      "eventId",
      "sourceVersion",
      "expectedNativeVersion",
      "payloadDigest",
      "businessBindingRevision",
      "approvalId",
    ]);
    const normalizedApproval: ExactApproval = Object.freeze({
      scope: scope(a.scope),
      direction: direction(a.direction),
      eventId: str(a.eventId),
      sourceVersion: str(a.sourceVersion),
      expectedNativeVersion: str(a.expectedNativeVersion),
      payloadDigest: str(a.payloadDigest),
      businessBindingRevision: str(a.businessBindingRevision),
      approvalId: str(a.approvalId),
    });
    const {
      payloadDigest: suppliedDigest,
      operationKey: suppliedKey,
      businessBindingRevision: suppliedBinding,
      ...input
    } = p;
    const normalized = await propose(input as unknown as ProposalInput);
    if (normalized.direction !== expected) fail("wrong-direction");
    if (
      normalized.payloadDigest !== suppliedDigest ||
      normalized.operationKey !== suppliedKey ||
      normalized.businessBindingRevision !== suppliedBinding
    )
      fail("proposal-integrity");
    if (
      JSON.stringify(normalized.scope) !==
        JSON.stringify(normalizedApproval.scope) ||
      normalized.direction !== normalizedApproval.direction ||
      normalized.eventId !== normalizedApproval.eventId ||
      normalized.sourceVersion !== normalizedApproval.sourceVersion ||
      normalized.expectedNativeVersion !==
        normalizedApproval.expectedNativeVersion ||
      normalized.payloadDigest !== normalizedApproval.payloadDigest ||
      normalized.businessBindingRevision !==
        normalizedApproval.businessBindingRevision
    )
      fail("approval-mismatch");
    if (
      (await businessAsset(normalized)) !== normalized.businessBindingRevision
    )
      fail("business-binding-changed");
    const claimed = await port.authorizeAndClaim(
      Object.freeze({ proposal: normalized, approval: normalizedApproval }),
    );
    if (claimed.kind === "outcome") return outcome(claimed.outcome, normalized);
    try {
      return await outcome(
        await port.executeClaimed(claimed.claim),
        normalized,
      );
    } catch {
      let persisted = false;
      try {
        await port.holdUncertain(claimed.claim);
        persisted = true;
      } catch {
        /* Original durable claim remains uncertain; never retry. */
      }
      throw new UncertainEffectError(normalized.operationKey, persisted);
    }
  }
  async function verified(proposal: Proposal): Promise<Proposal> {
    const p = record(proposal);
    exactKeys(
      p,
      [
        "scope",
        "direction",
        "eventId",
        "sourceVersion",
        "expectedNativeVersion",
        "fields",
        "businessBindingRevision",
        "payloadDigest",
        "operationKey",
      ],
      ["causalProvenance"],
    );
    const { payloadDigest, operationKey, businessBindingRevision, ...input } =
      p;
    const normalized = await propose(input as unknown as ProposalInput);
    if (
      normalized.payloadDigest !== payloadDigest ||
      normalized.operationKey !== operationKey ||
      normalized.businessBindingRevision !== businessBindingRevision
    )
      fail("proposal-integrity");
    return normalized;
  }
  return Object.freeze({
    propose,
    apply: (p: Proposal, a: ExactApproval) => run(p, a, "social-to-native"),
    publish: (p: Proposal, a: ExactApproval) => run(p, a, "native-to-social"),
    authorizedOutcome: async (p: Proposal) => {
      const n = await verified(p);
      const o = await port.readOutcome(n);
      return o === undefined ? undefined : outcome(o, n);
    },
    reconcile: async (p: Proposal) => {
      const n = await verified(p);
      return outcome(await port.reconcile(n), n);
    },
  });
}
