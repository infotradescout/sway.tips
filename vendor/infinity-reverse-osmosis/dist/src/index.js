export class ReverseOsmosisError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "ReverseOsmosisError";
    }
}
export class UncertainEffectError extends ReverseOsmosisError {
    operationKey;
    holdPersisted;
    constructor(operationKey, holdPersisted) {
        super("effect-uncertain-reconciliation-required");
        this.operationKey = operationKey;
        this.holdPersisted = holdPersisted;
    }
}
const fail = (code) => {
    throw new ReverseOsmosisError(code);
};
// Inspect descriptors before reading: no getters, custom prototypes, cycles, symbols or coercion.
function snapshot(value, depth = 0, seen = new Set(), budget = { nodes: 0 }) {
    if (++budget.nodes > 4096 || depth > 16)
        fail("payload-limit");
    if (value === null || typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        if (value.length > 16384)
            fail("payload-limit");
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            fail("unsafe-json");
        return value;
    }
    if (typeof value !== "object" || !value)
        return fail("unsafe-json");
    if (seen.has(value))
        fail("unsafe-json");
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !==
        (array ? Array.prototype : Object.prototype) &&
        Object.getPrototypeOf(value) !== null)
        fail("unsafe-json");
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length)
        fail("unsafe-json");
    const result = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) {
        if (array && key === "length")
            continue;
        if (key.length > 256)
            fail("payload-limit");
        if (["__proto__", "prototype", "constructor"].includes(key))
            fail("unsafe-json");
        const descriptor = descriptors[key];
        if (!("value" in descriptor) || !descriptor.enumerable)
            fail("unsafe-json");
        result[key] = snapshot(descriptor.value, depth + 1, seen, budget);
    }
    seen.delete(value);
    if (array) {
        const length = value.length;
        if (Object.keys(result).length !== length ||
            Object.keys(result).some((k) => !/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= length))
            fail("unsafe-json");
        return Object.freeze(Array.from({ length }, (_, i) => result[String(i)]));
    }
    return Object.freeze(result);
}
function record(value) {
    const result = snapshot(value);
    if (!result || typeof result !== "object" || Array.isArray(result))
        return fail("invalid-record");
    return result;
}
function exactKeys(value, keys, optional = []) {
    if (Object.keys(value).some((k) => !keys.includes(k) && !optional.includes(k)) ||
        keys.some((k) => !(k in value)))
        fail("invalid-fields");
}
function str(value) {
    if (typeof value !== "string" || !value || value.length > 512)
        return fail("invalid-identifier");
    return value;
}
function scope(value) {
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
function direction(value) {
    if (value !== "social-to-native" && value !== "native-to-social")
        return fail("invalid-direction");
    return value;
}
async function digest(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
export function createReverseOsmosisEngine(port) {
    async function outcome(value, p) {
        const o = record(value);
        exactKeys(o, ["operationKey", "payloadDigest", "status"], ["receipt"]);
        if (o.operationKey !== p.operationKey ||
            o.payloadDigest !== p.payloadDigest ||
            typeof o.status !== "string" ||
            !["completed", "denied", "held", "absent", "reflected"].includes(o.status))
            fail("outcome-mismatch");
        if (o.status === "reflected" &&
            (!port.verifyReflection || !(await port.verifyReflection(p))))
            fail("unverified-reflection");
        return o;
    }
    async function businessAsset(p) {
        const e = record(await port.verifyBusinessAsset(p));
        if (JSON.stringify(scope(e.scope)) !== JSON.stringify(p.scope) ||
            typeof e.assetKind !== "string" ||
            !["business-page", "business-account", "business-channel"].includes(e.assetKind) ||
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
            e.authorizedOwnerId !== p.scope.ownerId)
            fail("business-asset-required");
        return str(e.bindingRevision);
    }
    async function propose(input) {
        const p = record(input);
        exactKeys(p, [
            "scope",
            "direction",
            "eventId",
            "sourceVersion",
            "expectedNativeVersion",
            "fields",
        ], ["causalProvenance"]);
        const base = Object.freeze({
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
    async function run(proposal, approval, expected) {
        // Both snapshots happen before the first asynchronous boundary.
        const p = record(proposal);
        exactKeys(p, [
            "scope",
            "direction",
            "eventId",
            "sourceVersion",
            "expectedNativeVersion",
            "fields",
            "businessBindingRevision",
            "payloadDigest",
            "operationKey",
        ], ["causalProvenance"]);
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
        const normalizedApproval = Object.freeze({
            scope: scope(a.scope),
            direction: direction(a.direction),
            eventId: str(a.eventId),
            sourceVersion: str(a.sourceVersion),
            expectedNativeVersion: str(a.expectedNativeVersion),
            payloadDigest: str(a.payloadDigest),
            businessBindingRevision: str(a.businessBindingRevision),
            approvalId: str(a.approvalId),
        });
        const { payloadDigest: suppliedDigest, operationKey: suppliedKey, businessBindingRevision: suppliedBinding, ...input } = p;
        const normalized = await propose(input);
        if (normalized.direction !== expected)
            fail("wrong-direction");
        if (normalized.payloadDigest !== suppliedDigest ||
            normalized.operationKey !== suppliedKey ||
            normalized.businessBindingRevision !== suppliedBinding)
            fail("proposal-integrity");
        if (JSON.stringify(normalized.scope) !==
            JSON.stringify(normalizedApproval.scope) ||
            normalized.direction !== normalizedApproval.direction ||
            normalized.eventId !== normalizedApproval.eventId ||
            normalized.sourceVersion !== normalizedApproval.sourceVersion ||
            normalized.expectedNativeVersion !==
                normalizedApproval.expectedNativeVersion ||
            normalized.payloadDigest !== normalizedApproval.payloadDigest ||
            normalized.businessBindingRevision !==
                normalizedApproval.businessBindingRevision)
            fail("approval-mismatch");
        if ((await businessAsset(normalized)) !== normalized.businessBindingRevision)
            fail("business-binding-changed");
        const claimed = await port.authorizeAndClaim(Object.freeze({ proposal: normalized, approval: normalizedApproval }));
        if (claimed.kind === "outcome")
            return outcome(claimed.outcome, normalized);
        try {
            return await outcome(await port.executeClaimed(claimed.claim), normalized);
        }
        catch {
            let persisted = false;
            try {
                await port.holdUncertain(claimed.claim);
                persisted = true;
            }
            catch {
                /* Original durable claim remains uncertain; never retry. */
            }
            throw new UncertainEffectError(normalized.operationKey, persisted);
        }
    }
    async function verified(proposal) {
        const p = record(proposal);
        exactKeys(p, [
            "scope",
            "direction",
            "eventId",
            "sourceVersion",
            "expectedNativeVersion",
            "fields",
            "businessBindingRevision",
            "payloadDigest",
            "operationKey",
        ], ["causalProvenance"]);
        const { payloadDigest, operationKey, businessBindingRevision, ...input } = p;
        const normalized = await propose(input);
        if (normalized.payloadDigest !== payloadDigest ||
            normalized.operationKey !== operationKey ||
            normalized.businessBindingRevision !== businessBindingRevision)
            fail("proposal-integrity");
        return normalized;
    }
    return Object.freeze({
        propose,
        apply: (p, a) => run(p, a, "social-to-native"),
        publish: (p, a) => run(p, a, "native-to-social"),
        authorizedOutcome: async (p) => {
            const n = await verified(p);
            const o = await port.readOutcome(n);
            return o === undefined ? undefined : outcome(o, n);
        },
        reconcile: async (p) => {
            const n = await verified(p);
            return outcome(await port.reconcile(n), n);
        },
    });
}
