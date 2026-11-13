import { useMemo, useState } from "preact/hooks";
import type { Column, EntityRow } from "../api.js";

const PAGE = 200;

type Sort = { key: string; direction: "asc" | "desc" } | null;

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined || a === "") return 1; // empty cells last
  if (b === null || b === undefined || b === "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/** A long path keeps its start and its end: the file name is what tells rows apart. */
function middle(value: string, max = 56): string {
  if (value.length <= max) return value;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${value.slice(0, max - 1 - tail)}…${value.slice(value.length - tail)}`;
}

function Cell({ column, value }: { column: Column; value: unknown }) {
  if (value === null || value === undefined || value === "") return <span class="faint">–</span>;
  if (column.kind === "badge") return <span class="badge">{String(value)}</span>;
  if (column.kind === "number") return <>{Number(value).toLocaleString("en-US")}</>;
  if (column.kind === "code") return <span class="mono cell-code" title={String(value)}>{middle(String(value))}</span>;
  const text = String(value);
  return <span title={text}>{text.includes("/") && !/\s/.test(text) ? middle(text) : text}</span>;
}

/** A filterable, sortable table. Rows are keyboard focusable: Enter selects, the arrow keys move. */
export function DataTable(props: {
  noun: string;
  columns: Column[];
  rows: EntityRow[];
  selectedId?: string;
  onSelect: (row: EntityRow) => void;
  /** Shown instead of the table when there are no rows at all. */
  empty?: { title: string; text: string };
}) {
  const [text, setText] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<Sort>(null);
  const [shown, setShown] = useState(PAGE);

  const options = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const column of props.columns) {
      if (!column.filter) continue;
      result[column.key] = [...new Set(props.rows.map((r) => r[column.key]).filter((v) => v !== null && v !== "").map(String))].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [props.columns, props.rows]);

  const visible = useMemo(() => {
    const needle = text.trim().toLowerCase();
    let rows = props.rows.filter((row) => {
      for (const [key, value] of Object.entries(filters)) if (value && String(row[key] ?? "") !== value) return false;
      if (!needle) return true;
      return props.columns.some((c) => c.kind !== "number" && String(row[c.key] ?? "").toLowerCase().includes(needle));
    });
    if (sort) rows = [...rows].sort((a, b) => (sort.direction === "asc" ? 1 : -1) * compare(a[sort.key], b[sort.key]));
    return rows;
  }, [props.rows, props.columns, text, filters, sort]);

  const active = text.length > 0 || Object.values(filters).some(Boolean);
  const reset = () => { setText(""); setFilters({}); setShown(PAGE); };
  const toggleSort = (key: string) => setSort((s) => (s?.key !== key ? { key, direction: "asc" } : s.direction === "asc" ? { key, direction: "desc" } : null));

  if (props.rows.length === 0 && props.empty) {
    return <div class="empty"><h3>{props.empty.title}</h3><p>{props.empty.text}</p></div>;
  }

  const onKey = (event: KeyboardEvent, row: EntityRow) => {
    const target = event.currentTarget as HTMLElement;
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect(row); }
    else if (event.key === "ArrowDown") { event.preventDefault(); (target.nextElementSibling as HTMLElement | null)?.focus(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); (target.previousElementSibling as HTMLElement | null)?.focus(); }
  };

  return (
    <div class="table-wrap">
      <div class="table-tools">
        <input class="input table-search" type="search" placeholder={`Filter ${props.rows.length.toLocaleString("en-US")} ${props.noun}…`} aria-label={`Filter ${props.noun}`} value={text} onInput={(e) => { setText((e.target as HTMLInputElement).value); setShown(PAGE); }} />
        {props.columns.filter((c) => c.filter && (options[c.key]?.length ?? 0) > 1).map((column) => (
          <select class="input" aria-label={`Filter by ${column.label}`} value={filters[column.key] ?? ""} onChange={(e) => { setFilters({ ...filters, [column.key]: (e.target as HTMLSelectElement).value }); setShown(PAGE); }}>
            <option value="">{column.label}: all</option>
            {options[column.key]!.map((value) => <option value={value}>{value}</option>)}
          </select>
        ))}
        <span class="spacer" />
        <span class="muted small" aria-live="polite">{active ? `${visible.length.toLocaleString("en-US")} of ${props.rows.length.toLocaleString("en-US")}` : `${props.rows.length.toLocaleString("en-US")} ${props.noun}`}</span>
        {active && <button class="btn btn-ghost" onClick={reset}>Clear filters</button>}
      </div>
      {visible.length === 0 ? (
        <div class="empty"><h3>No {props.noun} match</h3><p>Try a shorter filter or clear the filters.</p><p><button class="btn" onClick={reset}>Clear filters</button></p></div>
      ) : (
        <table class="data">
          <thead>
            <tr>{props.columns.map((c) => (
              <th class={c.kind === "number" ? "num" : ""} aria-sort={sort?.key === c.key ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                <button onClick={() => toggleSort(c.key)} title={`Sort by ${c.label}`}>{c.label}<span class="sort" aria-hidden="true">{sort?.key === c.key ? (sort.direction === "asc" ? "▲" : "▼") : ""}</span></button>
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {visible.slice(0, shown).map((row) => (
              <tr tabIndex={0} aria-selected={row.id === props.selectedId} class={row.id === props.selectedId ? "selected" : ""} onClick={() => props.onSelect(row)} onKeyDown={(e) => onKey(e, row)}>
                {props.columns.map((c) => <td class={c.kind === "number" ? "num" : ""}><Cell column={c} value={row[c.key]} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {visible.length > shown && (
        <div class="table-more"><button class="btn" onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, visible.length - shown).toLocaleString("en-US")} more</button><span class="muted small">{shown.toLocaleString("en-US")} of {visible.length.toLocaleString("en-US")} shown</span></div>
      )}
    </div>
  );
}
