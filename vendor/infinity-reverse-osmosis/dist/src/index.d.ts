export type JSONValue = null | boolean | number | string | readonly JSONValue[] | {
    readonly [key: string]: JSONValue;
};
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
export type ClaimResult = {
    readonly kind: "claimed";
    readonly claim: NativeClaim;
} | {
    readonly kind: "outcome";
    readonly outcome: DurableOutcome;
};
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
export declare class ReverseOsmosisError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare class UncertainEffectError extends ReverseOsmosisError {
    readonly operationKey: string;
    readonly holdPersisted: boolean;
    constructor(operationKey: string, holdPersisted: boolean);
}
export declare function createReverseOsmosisEngine(port: NativePort): Readonly<{
    propose: (input: ProposalInput) => Promise<Proposal>;
    apply: (p: Proposal, a: ExactApproval) => Promise<DurableOutcome>;
    publish: (p: Proposal, a: ExactApproval) => Promise<DurableOutcome>;
    authorizedOutcome: (p: Proposal) => Promise<DurableOutcome | undefined>;
    reconcile: (p: Proposal) => Promise<DurableOutcome>;
}>;
//# sourceMappingURL=index.d.ts.map