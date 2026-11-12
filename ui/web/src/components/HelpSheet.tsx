import { useEffect, useRef } from "preact/hooks";
import { modifierKey } from "../lib/commands.js";

const sections = (mod: string): Array<{ title: string; rows: Array<[string[], string]> }> => [
  { title: "Everywhere", rows: [
    [[mod, "K"], "Command palette: views, actions, symbols, files and routes"],
    [["/"], "Search (in the graph) or open the palette"],
    [["?"], "This list"],
    [["Esc"], "Clear the selection, close a panel, step back out of a path or a focus"],
  ] },
  { title: "Graph", rows: [
    [["F"], "Fit the whole graph in view"],
    [["←", "→", "↑", "↓"], "Move between neighbouring nodes (click the graph first)"],
    [["Enter"], "Refocus on the highlighted node"],
    [["Shift", "click"], "Trace the path from the focused node to the one you click"],
    [["double-click"], "Open a folder in the overview"],
    [["scroll", "drag"], "Zoom and pan"],
  ] },
  { title: "Tables", rows: [
    [["↑", "↓"], "Move between rows"],
    [["Enter"], "Select the row and open it in the inspector"],
  ] },
];

/** A reference of the shortcuts, opened with ?. */
export function HelpSheet({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return (
    <dialog ref={dialog} class="dialog help" onClose={onClose} aria-labelledby="help-title">
      <div class="stack" style={{ minWidth: 380 }}>
        <div class="row"><h2 id="help-title">Keyboard shortcuts</h2><span class="spacer" /><button class="btn btn-ghost" onClick={onClose}>Close</button></div>
        {sections(modifierKey()).map((section) => (
          <section>
            <h4 class="section-h">{section.title}</h4>
            <table class="help-table"><tbody>
              {section.rows.map(([keys, text]) => <tr><td>{keys.map((k, i) => <>{i > 0 && " "}<span class="kbd">{k}</span></>)}</td><td>{text}</td></tr>)}
            </tbody></table>
          </section>
        ))}
      </div>
    </dialog>
  );
}
