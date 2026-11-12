import { runAffectedAdapter, type AffectedAdapterOptions } from "../adapters/cli/index.js";

export async function affectedCommand(files: string[], options: AffectedAdapterOptions): Promise<void> {
  await runAffectedAdapter(files, options);
}
