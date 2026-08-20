import { performance } from "node:perf_hooks";

import {
  createShellAdapter,
  denialReason,
  protectApprovedInput,
  snapshotHostInput,
  type AdapterOptions,
  type ShellAdapter,
} from "./adapter.ts";
import {
  PERMISSION_JUDGE_INSTRUCTION_V1,
  validatePermissionJudgeResponse,
} from "./judge.ts";
import {
  canOpenPiJudgeMenu,
  formatPiJudgeFooter,
  openPiJudgeMenu,
  type PiMenuModel,
} from "./pi-menu.ts";
import {
  createDefaultPiJudgePreferences,
  createMemoryPiPreferenceRepository,
  type PiPreferenceRepository,
} from "./pi-preferences.ts";
import {
  PermissionJudgeSession,
  createPermissionJudgeModelReference,
  type PermissionJudgeAvailability,
  type PermissionJudgeSessionAction,
} from "./session.ts";
import type {
  PermissionJudge,
  PermissionJudgeAuthorization,
  PermissionJudgeModelReference,
  PermissionJudgeOutcome,
  PermissionJudgeRequest,
  PermissionJudgeSessionPolicy,
  PermissionJudgeSessionStatus,
  PermissionJudgeThinking,
} from "./types.ts";

const MAX_CACHED_ADAPTERS = 32;
const MAX_COMPLETION_CONTENT_BLOCKS = 16;
const THINKING_LEVELS: readonly PermissionJudgeThinking[] = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface PiToolCallEvent {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
}

export interface PiToolCallBlock {
  readonly block: true;
  readonly reason: string;
}

export interface PiModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
  readonly baseUrl?: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Partial<Record<
    Exclude<PermissionJudgeThinking, "inherit">,
    string | null
  >>>;
  readonly [key: string]: unknown;
}

interface PiCompletionContext {
  readonly systemPrompt: string;
  readonly messages: readonly {
    readonly role: "user";
    readonly content: string;
    readonly timestamp: number;
  }[];
  readonly tools: readonly [];
}

interface PiCompletionOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly maxRetries: 0;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly env?: Readonly<Record<string, string>>;
  readonly reasoning?: Exclude<PermissionJudgeThinking, "inherit" | "off">;
}

interface PiAssistantStream {
  result(): Promise<unknown>;
}

interface PiProvider {
  streamSimple(
    model: PiModel,
    context: PiCompletionContext,
    options?: PiCompletionOptions,
  ): PiAssistantStream;
}

type PiRequestAuth =
  | {
      readonly ok: true;
      readonly apiKey?: string;
      readonly headers?: Readonly<Record<string, string | null>>;
      readonly baseUrl?: string;
      readonly env?: Readonly<Record<string, string>>;
    }
  | { readonly ok: false; readonly error?: string };

interface PiModelRegistry {
  getAvailable(): readonly PiModel[];
  find(provider: string, id: string): PiModel | undefined;
  complete?(model: PiModel, context: PiCompletionContext, options?: PiCompletionOptions): Promise<unknown>;
  getProvider?(provider: string): PiProvider | undefined;
  getApiKeyAndHeaders?(model: PiModel): Promise<PiRequestAuth>;
}

export interface PiExtensionCommand {
  readonly description?: string;
  readonly handler: (args: string, context: PiExtensionContext) => Promise<void>;
}

export interface PiExtensionShortcut {
  readonly description: string;
  readonly handler: (context: PiExtensionContext) => void | Promise<void>;
}

export interface PiExtensionContext {
  readonly cwd?: string;
  readonly sessionManager?: object;
  readonly modelRegistry?: PiModelRegistry;
  readonly scopedModels?: readonly { readonly model: PiModel; readonly thinkingLevel?: string }[];
  readonly model?: PiModel;
  readonly thinkingLevel?: string;
  readonly signal?: AbortSignal;
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly hasUI?: boolean;
  readonly ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void | Promise<void>;
    confirm?(title: string, message: string): boolean | Promise<boolean>;
    select?(title: string, options: readonly string[]): Promise<string | undefined>;
    input?(title: string, placeholder?: string): Promise<string | undefined>;
    setStatus?(key: string, text: string | undefined): void;
  };
  readonly [key: string]: unknown;
}

export interface PiExtensionAPI {
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEvent,
      context: PiExtensionContext,
    ) => PiToolCallBlock | undefined | Promise<PiToolCallBlock | undefined>,
  ): void;
  on(
    event: "session_start",
    handler: (event: unknown, context: PiExtensionContext) => void | Promise<void>,
  ): void;
  registerCommand?(name: string, command: PiExtensionCommand): void;
  registerShortcut?(shortcut: string, definition: PiExtensionShortcut): void;
}

export type PiExtension = (pi: PiExtensionAPI) => void;

export interface PiExtensionOptions extends AdapterOptions {
  readonly permissionJudgeSessionPolicy?: PermissionJudgeSessionPolicy;
}

export type PiAdapterOptionsResolver = (context: PiExtensionContext) => PiExtensionOptions;

interface PiProjectRuntime {
  readonly adapter: ShellAdapter;
  readonly permissionJudge: PermissionJudgeAuthorization;
  readonly sessionPolicy: PermissionJudgeSessionPolicy;
}

interface PiCommandSession {
  readonly session: PermissionJudgeSession;
  readonly preferences: PiPreferenceRepository;
  readonly availability: PermissionJudgeAvailability;
  readonly warning?: "invalid-or-unreadable";
}

export function createPiExtension(
  options: PiExtensionOptions | PiAdapterOptionsResolver = {},
  preferences: PiPreferenceRepository = createMemoryPiPreferenceRepository(),
): PiExtension {
  const resolveProject = createProjectResolver(options);
  const resolveSession = createSessionResolver(resolveProject, preferences);
  return (pi) => {
    registerToolCall(pi, resolveProject, resolveSession);
    registerJudgeCommand(pi, resolveSession);
    registerJudgeShortcuts(pi, resolveSession, preferences);
    registerSessionStatus(pi, resolveSession);
  };
}

export default createPiExtension();

function registerToolCall(
  pi: PiExtensionAPI,
  resolveProject: (context: PiExtensionContext) => PiProjectRuntime,
  resolveSession: (context: PiExtensionContext) => PiCommandSession | undefined,
): void {
  pi.on("tool_call", async (event, context) => {
    try {
      if (event.toolName !== "bash") return undefined;

      const snapshot = snapshotHostInput(event.input);
      if (snapshot === null) {
        return {
          block: true,
          reason: "AMG_DENY_INTERNAL_ERROR: The action input could not be read safely.",
        };
      }
      const call = { command: snapshot?.command };
      const project = resolveProject(context);
      const commandSession = resolveSession(context);
      const status = commandSession?.session.status(commandSession.availability);
      const timeoutMs = commandSession?.session.timeoutMs();
      const judge = status?.autoEffective && status.effectiveModel &&
          status.thinkingEffective && timeoutMs !== undefined
        ? createPiPermissionJudge(
            context,
            status.effectiveModel,
            status.thinkingEffective,
            timeoutMs,
          )
        : undefined;
      const evaluation = status?.autoRequested && project.adapter.evaluateWithJudge
        ? await project.adapter.evaluateWithJudge(call, judge, context.signal)
        : project.adapter.evaluate(call);
      if (evaluation.decision.blocked) {
        return { block: true, reason: denialReason(evaluation.decision) };
      }
      if (!protectApprovedInput(snapshot, evaluation.decision)) {
        return {
          block: true,
          reason: "AMG_DENY_INTERNAL_ERROR: The approved action could not be protected from later mutation.",
        };
      }
      return undefined;
    } catch {
      return {
        block: true,
        reason: "AMG_DENY_INTERNAL_ERROR: The action could not be evaluated safely.",
      };
    }
  });
}

function createPiPermissionJudge(
  context: PiExtensionContext,
  modelReference: PermissionJudgeModelReference,
  thinking: PermissionJudgeThinking,
  timeoutMs: number,
): PermissionJudge {
  return Object.freeze({
    async evaluate(request: PermissionJudgeRequest, signal: AbortSignal) {
      const model = resolveAvailableModel(context, modelReference);
      const transport = model
        ? createPiTransport(context.modelRegistry, model, thinking)
        : undefined;
      if (!transport) return Object.freeze({ status: "unavailable" });
      return completeWithDeadline(transport, request, timeoutMs, signal);
    },
  });
}

function createPiTransport(
  registry: PiModelRegistry | undefined,
  model: PiModel,
  thinking: PermissionJudgeThinking,
): ((context: PiCompletionContext, options: PiCompletionOptions) => Promise<unknown>) | undefined {
  if (!registry) return undefined;
  if (thinking === "inherit") {
    const complete = readMethod(registry, "complete");
    return complete
      ? async (context, options) => await Promise.resolve(
          Reflect.apply(complete, registry, [model, context, options]),
        )
      : undefined;
  }

  const getProvider = readMethod(registry, "getProvider");
  const getApiKeyAndHeaders = readMethod(registry, "getApiKeyAndHeaders");
  if (!getProvider || !getApiKeyAndHeaders) return undefined;

  return async (requestContext, options) => {
    const provider = Reflect.apply(getProvider, registry, [model.provider]);
    if (!isRecord(provider)) throw new Error("Pi provider is unavailable.");
    const streamSimple = readMethod(provider, "streamSimple");
    if (!streamSimple) throw new Error("Pi simple provider transport is unavailable.");

    if (options.signal.aborted) throw new Error("Pi judge request was cancelled.");
    const auth = await Promise.resolve(
      Reflect.apply(getApiKeyAndHeaders, registry, [model]),
    );
    if (options.signal.aborted) throw new Error("Pi judge request was cancelled.");
    if (!isRequestAuth(auth) || !auth.ok) {
      throw new Error("Pi model authentication is unavailable.");
    }
    const effectiveModel = typeof auth.baseUrl === "string"
      ? { ...model, baseUrl: auth.baseUrl }
      : model;
    const streamOptions: PiCompletionOptions = {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      maxRetries: 0,
      ...(typeof auth.apiKey === "string" ? { apiKey: auth.apiKey } : {}),
      ...(isStringRecord(auth.headers, true) ? { headers: auth.headers } : {}),
      ...(isStringRecord(auth.env, false) ? { env: auth.env } : {}),
      ...(thinking !== "off" ? { reasoning: thinking } : {}),
    };
    if (options.signal.aborted) throw new Error("Pi judge request was cancelled.");
    const stream = Reflect.apply(streamSimple, provider, [
      effectiveModel,
      requestContext,
      streamOptions,
    ]);
    if (!isRecord(stream)) throw new Error("Pi provider did not return a stream.");
    const result = readMethod(stream, "result");
    if (!result) throw new Error("Pi provider stream cannot produce a result.");
    return await Promise.resolve(Reflect.apply(result, stream, []));
  };
}

function completeWithDeadline(
  complete: (context: PiCompletionContext, options: PiCompletionOptions) => Promise<unknown>,
  request: PermissionJudgeRequest,
  timeoutMs: number,
  externalSignal: AbortSignal,
): Promise<PermissionJudgeOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + timeoutMs;

    const finish = (outcome: PermissionJudgeOutcome) => {
      if (settled) return;
      settled = true;
      try {
        if (timer !== undefined) clearTimeout(timer);
      } catch {
        // Cleanup failure must not keep the permission decision pending.
      }
      try {
        externalSignal.removeEventListener("abort", cancel);
      } catch {
        // Cleanup failure must not keep the permission decision pending.
      }
      resolve(Object.freeze(outcome));
    };
    const cancel = () => {
      finish({ status: "cancelled" });
      controller.abort();
    };

    if (externalSignal.aborted) {
      cancel();
      return;
    }
    externalSignal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      finish({ status: "timeout" });
      controller.abort();
    }, timeoutMs);

    const completionContext: PiCompletionContext = {
      systemPrompt: PERMISSION_JUDGE_INSTRUCTION_V1,
      messages: [{
        role: "user",
        content: JSON.stringify(request),
        timestamp: Date.now(),
      }],
      tools: [],
    };
    let completion: Promise<unknown>;
    try {
      completion = Promise.resolve().then(() => {
        if (settled || controller.signal.aborted) {
          throw new Error("Pi judge request was cancelled before dispatch.");
        }
        return complete(completionContext, {
          signal: controller.signal,
          timeoutMs,
          maxRetries: 0,
        });
      });
    } catch {
      finish(classifyTransportFailure(externalSignal, deadline));
      return;
    }

    completion.then(
      (message) => {
        if (performance.now() >= deadline) {
          finish({ status: "timeout" });
          return;
        }
        const outcome = readCompletion(message);
        finish(performance.now() >= deadline ? { status: "timeout" } : outcome);
      },
      () => finish(classifyTransportFailure(externalSignal, deadline)),
    );
    if (externalSignal.aborted) cancel();
  });
}

function classifyTransportFailure(
  externalSignal: AbortSignal,
  deadline: number,
): PermissionJudgeOutcome {
  return externalSignal.aborted
    ? { status: "cancelled" }
    : performance.now() >= deadline
      ? { status: "timeout" }
      : { status: "error" };
}

function readCompletion(message: unknown): PermissionJudgeOutcome {
  try {
    const snapshot = structuredClone(message);
    if (!isRecord(snapshot)) return Object.freeze({ status: "invalid-response" });
    const stopReason = snapshot.stopReason;
    if (stopReason === "error") return Object.freeze({ status: "error" });
    if (stopReason === "aborted") return Object.freeze({ status: "cancelled" });
    const contentBlocks = snapshot.content;
    if (stopReason !== "stop" || !Array.isArray(contentBlocks)) {
      return Object.freeze({ status: "invalid-response" });
    }
    const contentLength = contentBlocks.length;
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_COMPLETION_CONTENT_BLOCKS) {
      return Object.freeze({ status: "invalid-response" });
    }

    const text: string[] = [];
    for (let index = 0; index < contentLength; index += 1) {
      const content = contentBlocks[index];
      if (!isRecord(content) || typeof content.type !== "string") {
        return Object.freeze({ status: "invalid-response" });
      }
      if (content.type === "toolCall") return Object.freeze({ status: "invalid-response" });
      if (content.type === "thinking") continue;
      if (content.type !== "text" || typeof content.text !== "string") {
        return Object.freeze({ status: "invalid-response" });
      }
      text.push(content.text);
    }
    return text.length === 1
      ? validatePermissionJudgeResponse(text[0])
      : Object.freeze({ status: "invalid-response" });
  } catch {
    return Object.freeze({ status: "invalid-response" });
  }
}

function registerJudgeCommand(
  pi: PiExtensionAPI,
  resolveSession: (context: PiExtensionContext) => PiCommandSession | undefined,
): void {
  pi.registerCommand?.("amg-judge", {
    description: "Control the permission judge for this Pi session",
    async handler(args, context) {
      const commandSession = resolveSession(context);
      if (!commandSession) {
        notify(context, "Permission judge is unavailable for this session.", "warning");
        return;
      }
      notifyPreferenceWarning(context, commandSession);

      const values = args.trim().split(/\s+/u).filter(Boolean);
      if (values.length === 0 && canOpenPiJudgeMenu(context)) {
        await openJudgeMenu(context, commandSession);
        return;
      }
      const [command = "status", ...argumentsList] = values;
      switch (command.toLowerCase()) {
        case "on":
          await applySessionAction(context, commandSession, { type: "auto", enabled: true });
          notifyStatus(context, commandSession.session.status(commandSession.availability));
          return;
        case "off":
          await applySessionAction(context, commandSession, { type: "auto", enabled: false });
          notifyStatus(context, commandSession.session.status(commandSession.availability));
          return;
        case "status":
          notifyStatus(context, commandSession.session.status(commandSession.availability));
          return;
        case "model": {
          if (argumentsList.length !== 2) {
            notify(context, "Usage: /amg-judge model <provider> <model-id>", "warning");
            return;
          }
          const model = createPermissionJudgeModelReference(argumentsList[0], argumentsList[1]);
          if (!model) {
            notify(context, "Permission judge model reference is invalid.", "warning");
            return;
          }
          const changed = await applySessionAction(
            context,
            commandSession,
            { type: "model", model },
          );
          if (changed) notify(context, `Permission judge model set to ${formatModel(model)}.`, "info");
          return;
        }
        case "thinking": {
          if (argumentsList.length !== 1 || !isThinking(argumentsList[0])) {
            notify(context, "Permission judge thinking level is invalid.", "warning");
            return;
          }
          const changed = await applySessionAction(context, commandSession, {
            type: "thinking",
            thinking: argumentsList[0],
          });
          if (changed) notify(context, `Permission judge thinking set to ${argumentsList[0]}.`, "info");
          return;
        }
        case "reset": {
          const changed = await applySessionAction(context, commandSession, { type: "reset" });
          if (changed) notify(context, "Permission judge preferences reset.", "info");
          return;
        }
        default:
          notify(
            context,
            "Usage: /amg-judge <on|off|status|model <provider> <model-id>|thinking <level>|reset>",
            "warning",
          );
      }
    },
  });
}

function registerJudgeShortcuts(
  pi: PiExtensionAPI,
  resolveSession: (context: PiExtensionContext) => PiCommandSession | undefined,
  preferences: PiPreferenceRepository,
): void {
  if (!pi.registerShortcut) return;
  const loaded = safeLoadPreferences(preferences);
  pi.registerShortcut(loaded.preferences.shortcuts.menu, {
    description: "Open Auto Mode Gate controls",
    async handler(context) {
      const commandSession = resolveSession(context);
      if (!commandSession) return;
      if (canOpenPiJudgeMenu(context)) await openJudgeMenu(context, commandSession);
      else notifyStatus(context, commandSession.session.status(commandSession.availability));
    },
  });
  pi.registerShortcut(loaded.preferences.shortcuts.toggleAuto, {
    description: "Toggle the Auto Mode Gate permission judge",
    async handler(context) {
      const commandSession = resolveSession(context);
      if (!commandSession) return;
      await applySessionAction(context, commandSession, { type: "toggle-auto" });
      notifyStatus(context, commandSession.session.status(commandSession.availability));
    },
  });
}

function registerSessionStatus(
  pi: PiExtensionAPI,
  resolveSession: (context: PiExtensionContext) => PiCommandSession | undefined,
): void {
  pi.on("session_start", (_event, context) => {
    const commandSession = resolveSession(context);
    if (!commandSession) return;
    notifyPreferenceWarning(context, commandSession);
    updatePiStatus(context, commandSession.session.status(commandSession.availability));
  });
}

async function openJudgeMenu(
  context: PiExtensionContext,
  commandSession: PiCommandSession,
): Promise<void> {
  try {
    await openPiJudgeMenu(context, {
      status: () => commandSession.session.status(commandSession.availability),
      models: () => availableModels(context),
      thinking: () => {
        const status = commandSession.session.status(commandSession.availability);
        const model = status.preferredModel ?? status.model;
        return model
          ? commandSession.availability.supportedThinking(model)
          : ["inherit"];
      },
      setAuto: async (enabled) => {
        await applySessionAction(context, commandSession, { type: "auto", enabled });
      },
      setModel: async (model) => {
        await applySessionAction(context, commandSession, { type: "model", model });
      },
      setThinking: async (thinking) => {
        await applySessionAction(context, commandSession, { type: "thinking", thinking });
      },
      reset: async () => {
        await applySessionAction(context, commandSession, { type: "reset" });
      },
    });
  } catch {
    // A visual failure must not change the permission decision or stored state.
  }
}

async function applySessionAction(
  context: PiExtensionContext,
  commandSession: PiCommandSession,
  action: PermissionJudgeSessionAction,
): Promise<boolean> {
  const preview = commandSession.session.preview(action, commandSession.availability);
  if (!preview.accepted) {
    notifyTransitionFailure(context, preview.reason);
    return false;
  }
  try {
    commandSession.preferences.save(preview.preferences);
  } catch {
    notify(
      context,
      "Could not save Auto Mode Gate preferences; no changes were applied.",
      "error",
    );
    return false;
  }
  commandSession.session.commit(preview.preferences);
  updatePiStatus(context, commandSession.session.status(commandSession.availability));
  return true;
}

function createProjectResolver(
  options: PiExtensionOptions | PiAdapterOptionsResolver,
): (context: PiExtensionContext) => PiProjectRuntime {
  if (typeof options !== "function") {
    const project = createProjectRuntime(options);
    return () => project;
  }

  const projects = new Map<string, PiProjectRuntime>();
  return (context) => {
    const key = context.cwd ?? "";
    const existing = projects.get(key);
    if (existing) return existing;

    let project: PiProjectRuntime;
    try {
      project = createProjectRuntime(options(context));
    } catch {
      project = createProjectRuntime({
        permissionJudge: { authorized: false },
        onDecision() {
          throw new Error("Auto Mode Gate configuration could not be loaded safely.");
        },
      });
    }
    if (projects.size >= MAX_CACHED_ADAPTERS) {
      const oldestKey = projects.keys().next().value;
      if (oldestKey !== undefined) projects.delete(oldestKey);
    }
    projects.set(key, project);
    return project;
  };
}

function createProjectRuntime(options: PiExtensionOptions): PiProjectRuntime {
  const permissionJudge = options.permissionJudge ?? ({ authorized: false } as const);
  return Object.freeze({
    adapter: createShellAdapter("pi", options),
    permissionJudge,
    sessionPolicy: options.permissionJudgeSessionPolicy ?? policyFromAuthorization(permissionJudge),
  });
}

function createSessionResolver(
  resolveProject: (context: PiExtensionContext) => PiProjectRuntime,
  preferences: PiPreferenceRepository,
): (context: PiExtensionContext) => PiCommandSession | undefined {
  const sessions = new WeakMap<object, {
    readonly cwd: string;
    readonly session: PermissionJudgeSession;
    readonly warning?: "invalid-or-unreadable";
  }>();
  return (context) => {
    const sessionManager = context.sessionManager;
    if (!isObject(sessionManager)) return undefined;

    const cwd = context.cwd ?? "";
    const existing = sessions.get(sessionManager);
    if (existing?.cwd === cwd) {
      return Object.freeze({
        session: existing.session,
        preferences,
        availability: createAvailability(context),
        ...(existing.warning ? { warning: existing.warning } : {}),
      });
    }

    const project = resolveProject(context);
    const loaded = safeLoadPreferences(preferences);
    const session = new PermissionJudgeSession(project.sessionPolicy, loaded.preferences);
    sessions.set(sessionManager, {
      cwd,
      session,
      ...(loaded.warning ? { warning: loaded.warning } : {}),
    });
    return Object.freeze({
      session,
      preferences,
      availability: createAvailability(context),
      ...(loaded.warning ? { warning: loaded.warning } : {}),
    });
  };
}

function createAvailability(context: PiExtensionContext): PermissionJudgeAvailability {
  return Object.freeze({
    scopeAvailable: context.scopedModels !== undefined,
    isModelAvailable: (reference: PermissionJudgeModelReference) =>
      Boolean(resolveAvailableModel(context, reference)),
    supportedThinking: (reference: PermissionJudgeModelReference) => {
      const model = resolveAvailableModel(context, reference);
      return model ? supportedThinking(model) : ["inherit"] as const;
    },
  });
}

function availableModels(context: PiExtensionContext): readonly PiMenuModel[] {
  try {
    const registry = context.modelRegistry;
    const scoped = context.scopedModels;
    if (!registry || scoped === undefined) return [];
    const available = registry.getAvailable();
    const candidates = scoped.length === 0 ? available : scoped.map(({ model }) => model);
    return candidates.filter((model, index) =>
      available.some((candidate) => sameModel(candidate, model)) &&
      candidates.findIndex((candidate) => sameModel(candidate, model)) === index
    ).map((model) => Object.freeze({
      provider: model.provider,
      id: model.id,
      ...(typeof model.name === "string" ? { name: model.name } : {}),
    }));
  } catch {
    return [];
  }
}

function resolveAvailableModel(
  context: PiExtensionContext,
  reference: PermissionJudgeModelReference,
): PiModel | undefined {
  try {
    const registry = context.modelRegistry;
    const scoped = context.scopedModels;
    if (!registry || scoped === undefined) return undefined;
    const found = registry.find(reference.provider, reference.id);
    if (!found || !registry.getAvailable().some((model) => sameModel(model, reference))) {
      return undefined;
    }
    return scoped.length === 0 || scoped.some(({ model }) => sameModel(model, reference))
      ? found
      : undefined;
  } catch {
    return undefined;
  }
}

function supportedThinking(model: PiModel): readonly PermissionJudgeThinking[] {
  try {
    if (model.reasoning !== true) return ["inherit", "off"];
    const levels: PermissionJudgeThinking[] = ["inherit"];
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const mapped = model.thinkingLevelMap?.[level];
      if (mapped === null) continue;
      if ((level === "xhigh" || level === "max") && mapped === undefined) continue;
      levels.push(level);
    }
    return levels;
  } catch {
    return ["inherit"];
  }
}

function policyFromAuthorization(
  authorization: PermissionJudgeAuthorization,
): PermissionJudgeSessionPolicy {
  return Object.freeze({
    globalAuthorization: authorization,
    projectDisabled: false,
    ...(authorization.authorized ? { effectiveTimeoutMs: authorization.timeoutMs } : {}),
  });
}

function safeLoadPreferences(repository: PiPreferenceRepository) {
  try {
    return repository.load();
  } catch {
    return Object.freeze({
      preferences: createDefaultPiJudgePreferences(),
      warning: "invalid-or-unreadable" as const,
    });
  }
}

function notifyStatus(
  context: PiExtensionContext,
  status: PermissionJudgeSessionStatus,
): void {
  if (status.globalAuthorization === "not-authorized") {
    notify(context, "Permission judge is not authorized by global configuration.", "warning");
    return;
  }
  if (status.projectRestriction === "disabled") {
    notify(context, "Permission judge is disabled by project policy.", "warning");
    return;
  }
  if (status.reason === "scope-unavailable") {
    notify(context, "Permission judge model scope is unavailable.", "warning");
    return;
  }
  if (status.reason === "model-unavailable") {
    notify(context, "Permission judge model is not available.", "warning");
    return;
  }
  if (status.reason === "thinking-unsupported") {
    notify(context, "Permission judge thinking level is not supported by the selected model.", "warning");
    return;
  }
  const state = status.autoEffective ? "enabled" : "off";
  notify(
    context,
    `Permission judge ${state}. Model: ${formatModel(status.model)}. Thinking: ${status.thinkingRequested}.`,
    "info",
  );
}

function notifyTransitionFailure(
  context: PiExtensionContext,
  reason: "scope-unavailable" | "model-unavailable" | "thinking-unsupported",
): void {
  if (reason === "scope-unavailable") {
    notify(
      context,
      "Permission judge model scope is unavailable; no changes were applied.",
      "warning",
    );
  } else if (reason === "model-unavailable") {
    notify(context, "Permission judge model is not available.", "warning");
  } else {
    notify(
      context,
      "Permission judge thinking level is not supported by the selected model.",
      "warning",
    );
  }
}

function notifyPreferenceWarning(
  context: PiExtensionContext,
  commandSession: PiCommandSession,
): void {
  if (commandSession.warning) {
    notify(
      context,
      "Auto Mode Gate preferences could not be loaded; safe defaults are active.",
      "warning",
    );
  }
}

function updatePiStatus(
  context: PiExtensionContext,
  status: PermissionJudgeSessionStatus,
): void {
  try {
    context.ui?.setStatus?.("auto-mode-gate", formatPiJudgeFooter(status));
  } catch {
    // A UI failure must not change gate state or escape into the host.
  }
}

function notify(
  context: PiExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    const result = context.ui?.notify?.(message, type);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {
    // A UI failure must not change gate state or escape into the host.
  }
}

function formatModel(model: PermissionJudgeModelReference | undefined): string {
  return model ? `${model.provider}/${model.id}` : "unavailable";
}

function sameModel(
  left: PermissionJudgeModelReference | PiModel | undefined,
  right: PermissionJudgeModelReference | PiModel | undefined,
): boolean {
  return Boolean(left && right && left.provider === right.provider && left.id === right.id);
}

function readMethod(value: object, property: string): ((...args: unknown[]) => unknown) | undefined {
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === "function" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function isRequestAuth(value: unknown): value is PiRequestAuth {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return value.error === undefined || typeof value.error === "string";
  return (value.apiKey === undefined || typeof value.apiKey === "string") &&
    (value.baseUrl === undefined || typeof value.baseUrl === "string") &&
    isStringRecord(value.headers, true) &&
    isStringRecord(value.env, false);
}

function isStringRecord(value: unknown, allowNull: boolean): boolean {
  return value === undefined || isRecord(value) && Object.values(value).every(
    (entry) => typeof entry === "string" || allowNull && entry === null,
  );
}

function isThinking(value: string): value is PermissionJudgeThinking {
  return THINKING_LEVELS.includes(value as PermissionJudgeThinking);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
