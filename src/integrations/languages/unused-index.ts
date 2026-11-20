/** Identifier occurrences of the files visited: name -> unit -> count. */
export type IdentifierCounts = Map<string, Map<string, number>>;

export function addIdentifierCounts(index: IdentifierCounts, text: string, unit: string): void {
  for (const name of text.match(/[A-Za-z_]\w*/gu) ?? []) {
    let byUnit = index.get(name);
    if (!byUnit) index.set(name, byUnit = new Map());
    byUnit.set(unit, (byUnit.get(unit) ?? 0) + 1);
  }
}

export function mentionedOutside(index: IdentifierCounts, name: string, unit: string): boolean {
  for (const mentionUnit of index.get(name)?.keys() ?? []) {
    if (mentionUnit !== unit) return true;
  }
  return false;
}
