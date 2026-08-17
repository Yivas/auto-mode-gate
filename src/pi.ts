import {
  createShellAdapter,
  denialReason,
  type AdapterOptions,
  type ShellAdapter,
} from "./adapter.ts";
import {
  PermissionJudgeSession,
  createPermissionJudgeModelReference,
  type PermissionJudgeModelAvailability,
} from "./session.ts";
import type {
  PermissionJudgeAuthorization,
  PermissionJudgeModelReference,
  PermissionJudgeSessionStatus,
} from "./types.ts";

const MAX_CACHED_ADAPTERS = 32;

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
}

export interface PiExtensionCommand {
  readonly description?: string;
  readonly handler: (args: string, context: PiExtensionContext) => Promise<void>;
}

export interface PiExtensionContext {
  readonly cwd?: string;
  readonly sessionManager?: object;
  readonly modelRegistry?: {
    getAvailable(): readonly PiModel[];
    find(provider: string, id: string): PiModel | undefined;
  };
  readonly scopedModels?: readonly { readonly model: PiModel }[];
  readonly model?: PiModel;
  readonly ui?: {
    notify?(message: string, type?: "info" | "warning" | "error"): void;
    confirm?(title: string, message: string): boolean | Promise<boolean>;
  };
  readonly [key: string]: unknown;
}

export interface PiExtensionAPI {
  on(
    event: "tool_call",
    handler: (
      event: PiToolCallEvent,
      context: PiExtensionContext,
    ) => PiToolCallBlock | undefined,
  ): void;
  registerCommand?(name: string, command: PiExtensionCommand): void;
}

export type PiExtension = (pi: PiExtensionAPI) => void;
export type PiAdapterOptionsResolver = (context: PiExtensionContext) => AdapterOptions;

interface PiProjectRuntime {
  readonly adapter: ShellAdapter;
  readonly permissionJudge: PermissionJudgeAuthorization;
}

interface PiCommandSession {
  readonly session: PermissionJudgeSession;
  readonly isModelAvailable: PermissionJudgeModelAvailability;
}

export function createPiExtension(
  options: AdapterOptions | PiAdapterOptionsResolver = {},
): PiExtension {
  const resolveProject = createProjectResolver(options);
  const resolveSession = createSessionResolver(resolveProject);
  return (pi) => {
    registerToolCall(pi, resolveProject);
    registerJudgeCommand(pi, resolveSession);
  };
}

export default createPiExtension();

function registerToolCall(
  pi: PiExtensionAPI,
  resolveProject: (context: PiExtensionContext) => PiProjectRuntime,
): void {
  pi.on("tool_call", (event, context) => {
    try {
      if (event.toolName !== "bash") {
        return undefined;
      }

      const input = isRecord(event.input) ? event.input : undefined;
      const evaluation = resolveProject(context).adapter.evaluate({ command: input?.command });
      if (evaluation.decision.blocked) {
        return { block: true, reason: denialReason(evaluation.decision) };
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

      const [command = "status", ...values] = args.trim().split(/\s+/u).filter(Boolean);
      const { session, isModelAvailable } = commandSession;
      switch (command.toLowerCase()) {
        case "on": {
          const status = session.enable(isModelAvailable);
          notifyStatus(context, status, status.enabled ? "enabled" : undefined);
          return;
        }
        case "off": {
          const status = session.disable(isModelAvailable);
          notifyStatus(context, status, "disabled");
          return;
        }
        case "status": {
          notifyStatus(context, session.status(isModelAvailable));
          return;
        }
        case "model": {
          if (values.length !== 2) {
            notify(context, "Usage: /amg-judge model <provider> <model-id>", "warning");
            return;
          }
          const model = createPermissionJudgeModelReference(values[0], values[1]);
          if (!model) {
            notify(context, "Permission judge model reference is invalid.", "warning");
            return;
          }
          const status = session.setModel(model, isModelAvailable);
          if (!status.authorized) {
            notify(context, "Permission judge is not authorized by global configuration.", "warning");
            return;
          }
          if (!status.available || !sameModel(status.model, model)) {
            notify(context, "Permission judge model is not available.", "warning");
            return;
          }
          notify(context, `Permission judge model set to ${formatModel(model)}.`, "info");
          return;
        }
        case "reset": {
          const status = session.resetModel(isModelAvailable);
          if (!status.available) {
            notifyStatus(context, status);
            return;
          }
          notify(context, `Permission judge model reset to ${formatModel(status.model)}.`, "info");
          return;
        }
        default:
          notify(
            context,
            "Usage: /amg-judge <on|off|status|model <provider> <model-id>|reset>",
            "warning",
          );
      }
    },
  });
}

function createProjectResolver(
  options: AdapterOptions | PiAdapterOptionsResolver,
): (context: PiExtensionContext) => PiProjectRuntime {
  if (typeof options !== "function") {
    const project = createProjectRuntime(options);
    return () => project;
  }

  const projects = new Map<string, PiProjectRuntime>();
  return (context) => {
    const key = context.cwd ?? "";
    const existing = projects.get(key);
    if (existing) {
      return existing;
    }

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
      if (oldestKey !== undefined) {
        projects.delete(oldestKey);
      }
    }
    projects.set(key, project);
    return project;
  };
}

function createProjectRuntime(options: AdapterOptions): PiProjectRuntime {
  return Object.freeze({
    adapter: createShellAdapter("pi", options),
    permissionJudge: options.permissionJudge ?? ({ authorized: false } as const),
  });
}

function createSessionResolver(
  resolveProject: (context: PiExtensionContext) => PiProjectRuntime,
): (context: PiExtensionContext) => PiCommandSession | undefined {
  const sessions = new WeakMap<
    object,
    { readonly cwd: string; readonly session: PermissionJudgeSession }
  >();
  return (context) => {
    const sessionManager = context.sessionManager;
    if (!isObject(sessionManager)) {
      return undefined;
    }

    const cwd = context.cwd ?? "";
    const existing = sessions.get(sessionManager);
    if (existing?.cwd === cwd) {
      return Object.freeze({
        session: existing.session,
        isModelAvailable: createModelAvailability(context),
      });
    }

    const project = resolveProject(context);
    const session = new PermissionJudgeSession(project.permissionJudge);
    sessions.set(sessionManager, { cwd, session });
    return Object.freeze({
      session,
      isModelAvailable: createModelAvailability(context),
    });
  };
}

function createModelAvailability(context: PiExtensionContext): PermissionJudgeModelAvailability {
  return (reference) => {
    try {
      const registry = context.modelRegistry;
      if (!registry || !registry.find(reference.provider, reference.id)) {
        return false;
      }
      const available = registry.getAvailable();
      if (!available.some((model) => sameModel(model, reference))) {
        return false;
      }
      const scoped = context.scopedModels ?? [];
      return scoped.length === 0 || scoped.some(({ model }) => sameModel(model, reference));
    } catch {
      return false;
    }
  };
}

function notifyStatus(
  context: PiExtensionContext,
  status: PermissionJudgeSessionStatus,
  action?: "enabled" | "disabled",
): void {
  if (!status.authorized) {
    notify(context, "Permission judge is not authorized by global configuration.", "warning");
    return;
  }
  if (!status.available) {
    notify(context, "Permission judge model is not available.", "warning");
    return;
  }

  const state = action ?? (status.enabled ? "enabled" : "off");
  notify(context, `Permission judge ${state}. Model: ${formatModel(status.model)}.`, "info");
}

function notify(
  context: PiExtensionContext,
  message: string,
  type: "info" | "warning" | "error",
): void {
  try {
    context.ui?.notify?.(message, type);
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
  return Boolean(
    left &&
    right &&
    left.provider === right.provider &&
    left.id === right.id,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
