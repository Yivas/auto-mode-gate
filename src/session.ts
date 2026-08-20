import {
  MAX_PERMISSION_JUDGE_TIMEOUT_MS,
  MIN_PERMISSION_JUDGE_TIMEOUT_MS,
} from "./limits.ts";
import type {
  PermissionJudgeAuthorization,
  PermissionJudgeModelReference,
  PermissionJudgeSessionPolicy,
  PermissionJudgeSessionStatus,
  PermissionJudgeThinking,
  PiJudgePreferencesV1,
} from "./types.ts";

const MAX_PROVIDER_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 128;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const MODEL_ID_PATTERN = /^@?[a-z0-9][a-z0-9._:/@+-]*$/iu;
const DEFAULT_SHORTCUTS = Object.freeze({
  menu: "ctrl+alt+g",
  toggleAuto: "ctrl+alt+a",
});
const THINKING_LEVELS = new Set<PermissionJudgeThinking>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export type PermissionJudgeModelAvailability = (
  model: PermissionJudgeModelReference,
) => boolean;

export interface PermissionJudgeAvailability {
  readonly scopeAvailable: boolean;
  isModelAvailable(model: PermissionJudgeModelReference): boolean;
  supportedThinking(model: PermissionJudgeModelReference): readonly PermissionJudgeThinking[];
}

export type PermissionJudgeSessionAction =
  | { readonly type: "auto"; readonly enabled: boolean }
  | { readonly type: "toggle-auto" }
  | { readonly type: "model"; readonly model: PermissionJudgeModelReference }
  | { readonly type: "thinking"; readonly thinking: PermissionJudgeThinking }
  | { readonly type: "reset" };

export type PermissionJudgeSessionPreview =
  | {
      readonly accepted: true;
      readonly preferences: PiJudgePreferencesV1;
      readonly status: PermissionJudgeSessionStatus;
    }
  | {
      readonly accepted: false;
      readonly reason: "scope-unavailable" | "model-unavailable" | "thinking-unsupported";
      readonly status: PermissionJudgeSessionStatus;
    };

export class PermissionJudgeSession {
  readonly #policy: PermissionJudgeSessionPolicy;
  #preferences: PiJudgePreferencesV1;

  constructor(
    policy: PermissionJudgeAuthorization | PermissionJudgeSessionPolicy = { authorized: false },
    preferences: PiJudgePreferencesV1 = defaultPreferences(),
  ) {
    this.#policy = normalizePolicy(policy);
    this.#preferences = normalizePreferences(preferences);
  }

  status(
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    return statusFor(this.#policy, this.#preferences, normalizeAvailability(availability));
  }

  preview(
    action: PermissionJudgeSessionAction,
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionPreview {
    const normalizedAvailability = normalizeAvailability(availability);
    let next: PiJudgePreferencesV1;
    switch (action.type) {
      case "auto":
        next = withPreferences(this.#preferences, { autoEnabled: action.enabled });
        break;
      case "toggle-auto":
        next = withPreferences(this.#preferences, {
          autoEnabled: !this.#preferences.autoEnabled,
        });
        break;
      case "model": {
        const model = createPermissionJudgeModelReference(
          action.model.provider,
          action.model.id,
        );
        if (!normalizedAvailability.scopeAvailable || !model) {
          return rejectedPreview(
            "scope-unavailable",
            this.#policy,
            this.#preferences,
            normalizedAvailability,
          );
        }
        if (!safeModelAvailability(normalizedAvailability, model)) {
          return rejectedPreview(
            "model-unavailable",
            this.#policy,
            this.#preferences,
            normalizedAvailability,
          );
        }
        next = withPreferences(this.#preferences, { model });
        break;
      }
      case "thinking": {
        if (!THINKING_LEVELS.has(action.thinking)) {
          return rejectedPreview(
            "thinking-unsupported",
            this.#policy,
            this.#preferences,
            normalizedAvailability,
          );
        }
        const model = preferredModel(this.#policy, this.#preferences);
        if (
          !model ||
          !safeSupportedThinking(normalizedAvailability, model).includes(action.thinking)
        ) {
          return rejectedPreview(
            "thinking-unsupported",
            this.#policy,
            this.#preferences,
            normalizedAvailability,
          );
        }
        next = withPreferences(this.#preferences, {
          thinking: action.thinking === "inherit" ? undefined : action.thinking,
        });
        break;
      }
      case "reset":
        next = Object.freeze({
          version: 1,
          autoEnabled: this.#preferences.autoEnabled,
          shortcuts: this.#preferences.shortcuts,
        });
        break;
    }

    return Object.freeze({
      accepted: true,
      preferences: next,
      status: statusFor(this.#policy, next, normalizedAvailability),
    });
  }

  commit(preferences: PiJudgePreferencesV1): void {
    this.#preferences = normalizePreferences(preferences);
  }

  preferences(): PiJudgePreferencesV1 {
    return normalizePreferences(this.#preferences);
  }

  enable(
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    return commitLegacy(this, { type: "auto", enabled: true }, availability);
  }

  disable(
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    return commitLegacy(this, { type: "auto", enabled: false }, availability);
  }

  setModel(
    model: PermissionJudgeModelReference,
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    return commitLegacy(this, { type: "model", model }, availability);
  }

  resetModel(
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    const next = Object.freeze({
      ...this.#preferences,
      model: undefined,
    });
    this.#preferences = normalizePreferences(next);
    return this.status(availability);
  }

  setThinking(
    thinking: PermissionJudgeThinking,
    availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
  ): PermissionJudgeSessionStatus {
    return commitLegacy(this, { type: "thinking", thinking }, availability);
  }

  timeoutMs(): number | undefined {
    return this.#policy.globalAuthorization.authorized && !this.#policy.projectDisabled
      ? this.#policy.effectiveTimeoutMs
      : undefined;
  }
}

export function createPermissionJudgeModelReference(
  provider: unknown,
  id: unknown,
): PermissionJudgeModelReference | undefined {
  if (
    typeof provider !== "string" ||
    typeof id !== "string" ||
    provider.length === 0 ||
    provider.length > MAX_PROVIDER_LENGTH ||
    id.length === 0 ||
    id.length > MAX_MODEL_ID_LENGTH ||
    !PROVIDER_PATTERN.test(provider) ||
    !MODEL_ID_PATTERN.test(id)
  ) {
    return undefined;
  }
  return Object.freeze({ provider, id });
}

function statusFor(
  policy: PermissionJudgeSessionPolicy,
  preferences: PiJudgePreferencesV1,
  availability: PermissionJudgeAvailability,
): PermissionJudgeSessionStatus {
  const globallyAuthorized = policy.globalAuthorization.authorized;
  const model = preferredModel(policy, preferences);
  const modelAvailable = Boolean(
    globallyAuthorized &&
    !policy.projectDisabled &&
    availability.scopeAvailable &&
    model &&
    safeModelAvailability(availability, model),
  );
  const thinkingRequested = preferences.thinking ?? "inherit";
  const thinkingSupported = Boolean(
    model && safeSupportedThinking(availability, model).includes(thinkingRequested),
  );
  const available = modelAvailable && thinkingSupported;
  const autoEffective = preferences.autoEnabled && available;
  const reason = !globallyAuthorized
    ? "not-authorized" as const
    : policy.projectDisabled
      ? "project-disabled" as const
      : !availability.scopeAvailable
        ? "scope-unavailable" as const
        : !modelAvailable
          ? "model-unavailable" as const
          : !thinkingSupported
            ? "thinking-unsupported" as const
            : undefined;

  return Object.freeze({
    authorized: globallyAuthorized && !policy.projectDisabled,
    available,
    enabled: autoEffective,
    ...(model ? { model } : {}),
    ...(reason ? { reason } : {}),
    globalAuthorization: globallyAuthorized ? "authorized" : "not-authorized",
    projectRestriction: policy.projectDisabled ? "disabled" : "none",
    autoRequested: preferences.autoEnabled,
    autoEffective,
    ...(preferences.model ? { preferredModel: preferences.model } : {}),
    ...(modelAvailable && model ? { effectiveModel: model } : {}),
    modelAvailable,
    thinkingRequested,
    ...(available ? { thinkingEffective: thinkingRequested } : {}),
  });
}

function preferredModel(
  policy: PermissionJudgeSessionPolicy,
  preferences: PiJudgePreferencesV1,
): PermissionJudgeModelReference | undefined {
  return preferences.model ?? (
    policy.globalAuthorization.authorized
      ? policy.globalAuthorization.defaultModel
      : undefined
  );
}

function rejectedPreview(
  reason: Extract<PermissionJudgeSessionPreview, { accepted: false }>["reason"],
  policy: PermissionJudgeSessionPolicy,
  preferences: PiJudgePreferencesV1,
  availability: PermissionJudgeAvailability,
): PermissionJudgeSessionPreview {
  return Object.freeze({
    accepted: false,
    reason,
    status: statusFor(policy, preferences, availability),
  });
}

function commitLegacy(
  session: PermissionJudgeSession,
  action: PermissionJudgeSessionAction,
  availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
): PermissionJudgeSessionStatus {
  const preview = session.preview(action, availability);
  if (preview.accepted) session.commit(preview.preferences);
  return session.status(availability);
}

function normalizePolicy(
  policy: PermissionJudgeAuthorization | PermissionJudgeSessionPolicy,
): PermissionJudgeSessionPolicy {
  if ("globalAuthorization" in policy) {
    const globalAuthorization = normalizeAuthorization(policy.globalAuthorization);
    const effectiveTimeoutMs = policy.effectiveTimeoutMs;
    return Object.freeze({
      globalAuthorization,
      projectDisabled: policy.projectDisabled === true,
      ...(globalAuthorization.authorized &&
          Number.isInteger(effectiveTimeoutMs) &&
          effectiveTimeoutMs !== undefined &&
          effectiveTimeoutMs >= MIN_PERMISSION_JUDGE_TIMEOUT_MS &&
          effectiveTimeoutMs <= globalAuthorization.timeoutMs
        ? { effectiveTimeoutMs }
        : globalAuthorization.authorized && !policy.projectDisabled
          ? { effectiveTimeoutMs: globalAuthorization.timeoutMs }
          : {}),
    });
  }

  const globalAuthorization = normalizeAuthorization(policy);
  return Object.freeze({
    globalAuthorization,
    projectDisabled: false,
    ...(globalAuthorization.authorized
      ? { effectiveTimeoutMs: globalAuthorization.timeoutMs }
      : {}),
  });
}

function normalizeAuthorization(
  authorization: PermissionJudgeAuthorization,
): PermissionJudgeAuthorization {
  try {
    if (!authorization.authorized) {
      return Object.freeze({ authorized: false });
    }
    const defaultModel = createPermissionJudgeModelReference(
      authorization.defaultModel.provider,
      authorization.defaultModel.id,
    );
    const timeoutMs = authorization.timeoutMs;
    if (
      !defaultModel ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < MIN_PERMISSION_JUDGE_TIMEOUT_MS ||
      timeoutMs > MAX_PERMISSION_JUDGE_TIMEOUT_MS
    ) {
      return Object.freeze({ authorized: false });
    }
    return Object.freeze({ authorized: true, defaultModel, timeoutMs });
  } catch {
    return Object.freeze({ authorized: false });
  }
}

function normalizePreferences(preferences: PiJudgePreferencesV1): PiJudgePreferencesV1 {
  const model = preferences.model
    ? createPermissionJudgeModelReference(preferences.model.provider, preferences.model.id)
    : undefined;
  const thinking = preferences.thinking;
  if (
    preferences.version !== 1 ||
    typeof preferences.autoEnabled !== "boolean" ||
    (preferences.model !== undefined && !model) ||
    (thinking !== undefined && !THINKING_LEVELS.has(thinking)) ||
    typeof preferences.shortcuts?.menu !== "string" ||
    typeof preferences.shortcuts?.toggleAuto !== "string"
  ) {
    return defaultPreferences();
  }
  return Object.freeze({
    version: 1,
    autoEnabled: preferences.autoEnabled,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    shortcuts: Object.freeze({ ...preferences.shortcuts }),
  });
}

function withPreferences(
  current: PiJudgePreferencesV1,
  change: {
    readonly autoEnabled?: boolean;
    readonly model?: PermissionJudgeModelReference;
    readonly thinking?: PermissionJudgeThinking;
  },
): PiJudgePreferencesV1 {
  const hasModel = Object.hasOwn(change, "model");
  const hasThinking = Object.hasOwn(change, "thinking");
  return normalizePreferences({
    version: 1,
    autoEnabled: change.autoEnabled ?? current.autoEnabled,
    ...(!hasModel && current.model ? { model: current.model } : {}),
    ...(hasModel && change.model ? { model: change.model } : {}),
    ...(!hasThinking && current.thinking ? { thinking: current.thinking } : {}),
    ...(hasThinking && change.thinking ? { thinking: change.thinking } : {}),
    shortcuts: current.shortcuts,
  });
}

function normalizeAvailability(
  availability: PermissionJudgeModelAvailability | PermissionJudgeAvailability,
): PermissionJudgeAvailability {
  if (typeof availability === "function") {
    return Object.freeze({
      scopeAvailable: true,
      isModelAvailable: availability,
      supportedThinking: (): readonly PermissionJudgeThinking[] => [
        "inherit",
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
    });
  }
  return availability;
}

function safeModelAvailability(
  availability: PermissionJudgeAvailability,
  model: PermissionJudgeModelReference,
): boolean {
  try {
    return availability.isModelAvailable(model) === true;
  } catch {
    return false;
  }
}

function safeSupportedThinking(
  availability: PermissionJudgeAvailability,
  model: PermissionJudgeModelReference,
): readonly PermissionJudgeThinking[] {
  try {
    const levels = availability.supportedThinking(model);
    return ["inherit", ...levels.filter(
      (level, index) => level !== "inherit" && THINKING_LEVELS.has(level) &&
        levels.indexOf(level) === index,
    )];
  } catch {
    return ["inherit"];
  }
}

function defaultPreferences(): PiJudgePreferencesV1 {
  return Object.freeze({
    version: 1,
    autoEnabled: false,
    shortcuts: DEFAULT_SHORTCUTS,
  });
}
