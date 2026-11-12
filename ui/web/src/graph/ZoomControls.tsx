export function ZoomControls(props: { onIn: () => void; onOut: () => void; onFit: () => void }) {
  return (
    <div class="zoom-controls" role="group" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button class="btn btn-icon" onClick={props.onIn} title="Zoom in" aria-label="Zoom in">+</button>
      <button class="btn btn-icon" onClick={props.onOut} title="Zoom out" aria-label="Zoom out">−</button>
      <button class="btn" onClick={props.onFit} title="Fit the whole graph in view">Fit</button>
    </div>
  );
}
