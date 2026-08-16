export { AutoModeGate, RejectionTracker, mergeConfig } from "./core.ts";
export { createShellAdapter, denialReason } from "./adapter.ts";
export { getDefaultGlobalConfigPath, loadAdapterOptions, PROJECT_CONFIG_NAME } from "./config.ts";
export { AutoModeGateOpenCodePlugin, createOpenCodeHooks, createOpenCodePlugin } from "./opencode.ts";
export { createPiExtension } from "./pi.ts";
export type {
  AdapterEvaluation,
  AdapterOptions,
  AdapterShellCall,
  ShellAdapter,
} from "./adapter.ts";
export type {
  OpenCodeHooks,
  OpenCodePlugin,
  OpenCodeToolBeforeInput,
  OpenCodeToolBeforeOutput,
} from "./opencode.ts";
export type {
  PiAdapterOptionsResolver,
  PiExtension,
  PiExtensionAPI,
  PiExtensionContext,
  PiToolCallBlock,
  PiToolCallEvent,
} from "./pi.ts";
export type { ConfigDiscoveryOptions } from "./config.ts";
export type {
  ActionContext,
  DecisionCode,
  DecisionLogRecord,
  GateConfig,
  GateDecision,
  GateEffect,
  GateMode,
  HostCapabilities,
  KnownHost,
  NormalizedShellAction,
  PolicyVerdict,
  Shell,
  StructuredDenial,
  VerifiedExecutable,
} from "./types.ts";
