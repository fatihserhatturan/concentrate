import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export type View = { x: number; y: number; k: number };
const MIN = 0.05;
const MAX = 4;

/** Pan and zoom for an element: drag the background, wheel to zoom at the cursor, fit to content. */
export function useViewport() {
  const ref = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  /** True right after a drag, so the click that ends it is not taken for a click on a node. */
  const dragged = useRef(false);

  const fit = useCallback((width: number, height: number) => {
    const box = ref.current?.getBoundingClientRect();
    if (!box || width <= 0 || height <= 0) return;
    const k = Math.min(box.width / width, box.height / height, 1.15) * 0.95;
    setView({ k, x: (box.width - width * k) / 2, y: (box.height - height * k) / 2 });
  }, []);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const box = ref.current?.getBoundingClientRect();
    const px = cx ?? (box ? box.width / 2 : 0);
    const py = cy ?? (box ? box.height / 2 : 0);
    setView((v) => {
      const k = Math.min(MAX, Math.max(MIN, v.k * factor));
      return { k, x: px - (px - v.x) * (k / v.k), y: py - (py - v.y) * (k / v.k) };
    });
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const handlers = {
    onPointerDown: (event: PointerEvent) => {
      if (event.button !== 0) return;
      drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, moved: false };
      dragged.current = false;
    },
    onPointerMove: (event: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = event.clientX - d.x;
      const dy = event.clientY - d.y;
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      d.moved = true;
      dragged.current = true;
      setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
    },
    onPointerUp: () => {
      drag.current = null;
      // The click event follows pointerup; clear the flag after it.
      setTimeout(() => { dragged.current = false; }, 0);
    },
  };

  return { ref, view, setView, fit, zoomIn: () => zoomAt(1.3), zoomOut: () => zoomAt(1 / 1.3), handlers, dragged };
}
