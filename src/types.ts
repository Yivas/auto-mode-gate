export type Shell = "bash" | "powershell" | "cmd";
export type GateMode = "off" | "shadow" | "enforce";
export type PolicyVerdict = "allow" | "deny" | "ambiguous";
export type GateEffect = "allow" | "deny";
export type DecisionSource = "deterministic";
export type KnownHost = "opencode" | "pi" | "unknown";

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

export type DecisionCode =
  | "AMG_ALLOW_SAFE_COMMAND"
  | "AMG_DENY_DANGEROUS_COMMAND"
  | "AMG_DENY_AMBIGUOUS"
  | "AMG_DENY_UNKNOWN_ACTION"
  | "AMG_DENY_INVALID_INPUT"
  | "AMG_DENY_INTERNAL_ERROR";

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
