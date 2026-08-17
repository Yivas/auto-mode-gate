import {
  MAX_PERMISSION_JUDGE_TIMEOUT_MS,
  MIN_PERMISSION_JUDGE_TIMEOUT_MS,
} from "./limits.ts";
import type {
  PermissionJudgeAuthorization,
  PermissionJudgeModelReference,
  PermissionJudgeSessionStatus,
} from "./types.ts";

const MAX_PROVIDER_LENGTH = 64;
const MAX_MODEL_ID_LENGTH = 128;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;
const MODEL_ID_PATTERN = /^@?[a-z0-9][a-z0-9._:/@+-]*$/iu;

export type PermissionJudgeModelAvailability = (
  model: PermissionJudgeModelReference,
) => boolean;

export class PermissionJudgeSession {
  readonly #authorization: PermissionJudgeAuthorization;
  #enabled = false;
  #modelOverride: PermissionJudgeModelReference | undefined;

  constructor(authorization: PermissionJudgeAuthorization = { authorized: false }) {
    this.#authorization = normalizeAuthorization(authorization);
  }

  status(isAvailable: PermissionJudgeModelAvailability): PermissionJudgeSessionStatus {
    if (!this.#authorization.authorized) {
      this.#enabled = false;
      return Object.freeze({
        authorized: false,
        available: false,
        enabled: false,
        reason: "not-authorized",
      });
    }

    const model = this.#modelOverride ?? this.#authorization.defaultModel;
    if (!safeAvailabilityCheck(isAvailable, model)) {
      this.#enabled = false;
      return Object.freeze({
        authorized: true,
        available: false,
        enabled: false,
        model,
        reason: "model-unavailable",
      });
    }

    return Object.freeze({
      authorized: true,
      available: true,
      enabled: this.#enabled,
      model,
    });
  }

  enable(isAvailable: PermissionJudgeModelAvailability): PermissionJudgeSessionStatus {
    const status = this.status(isAvailable);
    if (status.available) {
      this.#enabled = true;
      return Object.freeze({ ...status, enabled: true });
    }
    return status;
  }

  disable(isAvailable: PermissionJudgeModelAvailability): PermissionJudgeSessionStatus {
    this.#enabled = false;
    return this.status(isAvailable);
  }

  setModel(
    model: PermissionJudgeModelReference,
    isAvailable: PermissionJudgeModelAvailability,
  ): PermissionJudgeSessionStatus {
    if (!this.#authorization.authorized || !safeAvailabilityCheck(isAvailable, model)) {
      return this.status(isAvailable);
    }
    this.#modelOverride = Object.freeze({ ...model });
    return this.status(isAvailable);
  }

  resetModel(isAvailable: PermissionJudgeModelAvailability): PermissionJudgeSessionStatus {
    this.#modelOverride = undefined;
    return this.status(isAvailable);
  }

  timeoutMs(): number | undefined {
    return this.#authorization.authorized ? this.#authorization.timeoutMs : undefined;
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
    return Object.freeze({
      authorized: true,
      defaultModel,
      timeoutMs,
    });
  } catch {
    return Object.freeze({ authorized: false });
  }
}

function safeAvailabilityCheck(
  isAvailable: PermissionJudgeModelAvailability,
  model: PermissionJudgeModelReference,
): boolean {
  try {
    return isAvailable(model) === true;
  } catch {
    return false;
  }
}
