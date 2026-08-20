import type {
  PermissionJudgeModelReference,
  PermissionJudgeSessionStatus,
  PermissionJudgeThinking,
} from "./types.ts";

export interface PiMenuModel extends PermissionJudgeModelReference {
  readonly name?: string;
}

export interface PiMenuUI {
  select?(title: string, options: readonly string[]): Promise<string | undefined>;
  input?(title: string, placeholder?: string): Promise<string | undefined>;
}

interface ActivePiMenuUI {
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface PiMenuContext {
  readonly mode?: "tui" | "rpc" | "json" | "print";
  readonly hasUI?: boolean;
  readonly ui?: PiMenuUI;
}

export interface PiMenuOperations {
  status(): PermissionJudgeSessionStatus;
  models(): readonly PiMenuModel[];
  thinking(): readonly PermissionJudgeThinking[];
  setAuto(enabled: boolean): Promise<void>;
  setModel(model: PermissionJudgeModelReference): Promise<void>;
  setThinking(thinking: PermissionJudgeThinking): Promise<void>;
  reset(): Promise<void>;
}

export function canOpenPiJudgeMenu(context: PiMenuContext): boolean {
  return context.mode === "tui" && context.hasUI === true &&
    typeof context.ui?.select === "function" &&
    typeof context.ui?.input === "function";
}

export async function openPiJudgeMenu(
  context: PiMenuContext,
  operations: PiMenuOperations,
): Promise<void> {
  const ui = activePiMenuUI(context);
  if (!ui) return;

  while (true) {
    const status = operations.status();
    const rows = [
      `Auto: ${formatAuto(status)}`,
      `Judge model: ${formatModel(status)}`,
      `Thinking: ${formatThinking(status)}`,
      "Reset model and thinking",
    ];
    const selected = await ui.select("Auto Mode Gate", rows);
    if (selected === undefined) return;

    if (selected === rows[0]) {
      await operations.setAuto(!status.autoRequested);
      continue;
    }
    if (selected === rows[1]) {
      await selectModel(ui, operations);
      continue;
    }
    if (selected === rows[2]) {
      await selectThinking(ui, operations);
      continue;
    }
    if (selected === rows[3]) {
      await operations.reset();
    }
  }
}

export function formatPiJudgeFooter(status: PermissionJudgeSessionStatus): string {
  if (!status.autoRequested) return "AMG:off";
  if (status.autoEffective) return "AMG:on→on";
  return status.reason === undefined ? "AMG:on→off" : "AMG:on→unavailable";
}

export function filterPiMenuModels(
  models: readonly PiMenuModel[],
  query: string,
): readonly PiMenuModel[] {
  const normalized = query.trim().toLowerCase();
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider}\u0000${model.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return normalized === "" ||
      `${model.provider}/${model.id} ${model.name ?? ""}`.toLowerCase().includes(normalized);
  });
}

async function selectModel(
  ui: ActivePiMenuUI,
  operations: PiMenuOperations,
): Promise<void> {
  const query = await ui.input("Search judge models", "provider, model ID, or name");
  if (query === undefined) return;
  const models = filterPiMenuModels(operations.models(), query);
  if (models.length === 0) {
    await ui.select("Judge model", ["No matching models."]);
    return;
  }
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const selected = await ui.select("Judge model", labels);
  const index = selected === undefined ? -1 : labels.indexOf(selected);
  if (index >= 0) await operations.setModel(models[index]);
}

async function selectThinking(
  ui: ActivePiMenuUI,
  operations: PiMenuOperations,
): Promise<void> {
  const query = await ui.input("Search thinking levels", "inherit, off, low, high…");
  if (query === undefined) return;
  const normalized = query.trim().toLowerCase();
  const levels = operations.thinking().filter(
    (level) => normalized === "" || level.includes(normalized),
  );
  if (levels.length === 0) {
    await ui.select("Thinking", ["No matching thinking levels."]);
    return;
  }
  const selected = await ui.select("Thinking", levels);
  if (selected !== undefined && isThinking(selected)) {
    await operations.setThinking(selected);
  }
}

function activePiMenuUI(context: PiMenuContext): ActivePiMenuUI | undefined {
  const ui = context.ui;
  if (!canOpenPiJudgeMenu(context) || !ui?.select || !ui.input) return undefined;
  const select = ui.select.bind(ui);
  const input = ui.input.bind(ui);
  return Object.freeze({ select, input });
}

function formatAuto(status: PermissionJudgeSessionStatus): string {
  const requested = status.autoRequested ? "on" : "off";
  const effective = status.autoEffective ? "on" : status.reason ? "unavailable" : "off";
  return requested === effective ? requested : `requested ${requested} · effective ${effective}`;
}

function formatModel(status: PermissionJudgeSessionStatus): string {
  const requested = status.preferredModel ?? status.model;
  const label = requested ? `${requested.provider}/${requested.id}` : "unavailable";
  return status.modelAvailable ? label : `${label} · unavailable`;
}

function formatThinking(status: PermissionJudgeSessionStatus): string {
  return status.thinkingEffective === undefined
    ? `${status.thinkingRequested} · unavailable`
    : status.thinkingRequested;
}

function isThinking(value: string): value is PermissionJudgeThinking {
  return ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .includes(value);
}
