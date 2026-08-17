export type Shell = "bash" | "powershell" | "cmd";
export type GateMode = "off" | "shadow" | "enforce";
export type PolicyVerdict = "allow" | "deny" | "ambiguous";
export type GateEffect = "allow" | "deny";
export type DecisionSource = "deterministic";
export type PermissionJudgeDecisionSource = "judge";
export type KnownHost = "opencode" | "pi" | "unknown";

export type PermissionAssessmentState =
  | "allow-final"
  | "deny-final"
  | "unresolved-ineligible"
  | "unresolved-eligible";

export type PermissionJudgeOperation = "diff" | "log" | "show" | "status";

export type PermissionJudgeOptionRisk =
  | "read-modifier"
  | "write"
  | "execute"
  | "network"
  | "force"
  | "recursive"
  | "credential";

export type PermissionJudgeArgumentKind = "path" | "url" | "number" | "value";

export interface PermissionJudgeRequest {
  readonly protocol: "amg-permission-judge/v1";
}

export interface PermissionJudgeSanitizedRequest extends PermissionJudgeRequest {
  readonly shell: Shell;
  readonly executable: "git";
  readonly operation: PermissionJudgeOperation;
  readonly optionRisks: readonly PermissionJudgeOptionRisk[];
  readonly argumentKinds: readonly PermissionJudgeArgumentKind[];
  readonly syntax: "simple-literal";
}

export type JudgeEligibility =
  | { readonly state: "ineligible" }
  | { readonly state: "eligible"; readonly request: PermissionJudgeSanitizedRequest };

export type PermissionAssessment =
  | { readonly state: "allow-final"; readonly policyVerdict: "allow" }
  | { readonly state: "deny-final"; readonly policyVerdict: "deny" }
  | {
      readonly state: "unresolved-ineligible";
      readonly policyVerdict: "ambiguous";
      readonly eligibility: Extract<JudgeEligibility, { readonly state: "ineligible" }>;
    }
  | {
      readonly state: "unresolved-eligible";
      readonly policyVerdict: "ambiguous";
      readonly eligibility: Extract<JudgeEligibility, { readonly state: "eligible" }>;
    };

export type PermissionJudgeVerdict = "allow" | "deny";

export interface PermissionJudgeResponse {
  readonly protocol: "amg-permission-judge/v1";
  readonly verdict: PermissionJudgeVerdict;
}

export type PermissionJudgeFailure =
  | "unavailable"
  | "timeout"
  | "cancelled"
  | "invalid-response"
  | "error";

export type PermissionJudgeOutcome =
  | { readonly status: "response"; readonly response: PermissionJudgeResponse }
  | { readonly status: PermissionJudgeFailure };

export interface PermissionJudge {
  evaluate(request: PermissionJudgeRequest, signal: AbortSignal): Promise<unknown>;
}

export interface PermissionJudgeModelReference {
  readonly provider: string;
  readonly id: string;
}

export type PermissionJudgeAuthorization =
  | { readonly authorized: false }
  | {
      readonly authorized: true;
      readonly defaultModel: PermissionJudgeModelReference;
      readonly timeoutMs: number;
    };

export interface PermissionJudgeSessionStatus {
  readonly authorized: boolean;
  readonly available: boolean;
  readonly enabled: boolean;
  readonly model?: PermissionJudgeModelReference;
  readonly reason?: "not-authorized" | "model-unavailable";
}

export interface ActionContext {
  readonly interactive?: boolean;
}

export interface HostCapabilities {
  readonly userConfirmation?: boolean;
}

export interface VerifiedExecutable {
  readonly name: string;
  readonly path: string;
  readonly source: "trusted-path";
}

export interface NormalizedShellAction {
  readonly kind: "shell";
  readonly tool: "shell";
  readonly shell: Shell;
  readonly command: string;
  readonly executable?: VerifiedExecutable;
  readonly truncated?: boolean;
  readonly host?: KnownHost;
  readonly context?: ActionContext;
  readonly capabilities?: HostCapabilities;
}

export type DeterministicDecisionCode =
  | "AMG_ALLOW_SAFE_COMMAND"
  | "AMG_DENY_DANGEROUS_COMMAND"
  | "AMG_DENY_AMBIGUOUS"
  | "AMG_DENY_UNKNOWN_ACTION"
  | "AMG_DENY_INVALID_INPUT"
  | "AMG_DENY_INTERNAL_ERROR";

export type PermissionJudgeDecisionCode =
  | "AMG_ALLOW_JUDGE"
  | "AMG_DENY_JUDGE"
  | "AMG_DENY_JUDGE_UNAVAILABLE"
  | "AMG_DENY_JUDGE_TIMEOUT"
  | "AMG_DENY_JUDGE_CANCELLED"
  | "AMG_DENY_JUDGE_INVALID_RESPONSE"
  | "AMG_DENY_JUDGE_ERROR";

export type DecisionCode = DeterministicDecisionCode;

export interface StructuredDenial {
  readonly code: Exclude<DecisionCode, "AMG_ALLOW_SAFE_COMMAND">;
  readonly message: string;
}

export interface DecisionLogRecord {
  readonly host: KnownHost;
  readonly tool: "shell" | "unknown";
  readonly shell: Shell | "unknown";
  readonly policyVerdict: PolicyVerdict;
  readonly effect: GateEffect;
  readonly code: DecisionCode;
  readonly source: DecisionSource;
  readonly mode: GateMode;
  readonly blocked: boolean;
  readonly repeatedRejectionCount: number;
}

export interface GateDecision {
  readonly policyVerdict: PolicyVerdict;
  readonly effect: GateEffect;
  readonly code: DecisionCode;
  readonly source: DecisionSource;
  readonly mode: GateMode;
  readonly blocked: boolean;
  readonly denial?: StructuredDenial;
  readonly repeatedRejectionCount: number;
  readonly log: DecisionLogRecord;
}

export interface GateConfig {
  readonly mode: GateMode;
  readonly trustedExecutablePaths?: readonly string[];
}
