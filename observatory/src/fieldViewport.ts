/** Normalized data coordinates stay fixed; navigation changes only the view. */
export type FieldViewport = { zoom: number; x: number; y: number };
export type PlotBounds = {
  left: number;
  top: number;
  width: number;
  height: number;
};
export const DEFAULT_VIEW: FieldViewport = { zoom: 1, x: 0, y: 0 };
export function boundedView(view: FieldViewport): FieldViewport {
  const zoom = Math.max(1, Math.min(6, view.zoom));
  const limit = 1 - 1 / zoom;
  return {
    zoom,
    x: Math.max(-limit, Math.min(limit, view.x)) || 0,
    y: Math.max(-limit, Math.min(limit, view.y)) || 0,
  };
}
export function project(
  x: number,
  y: number,
  view: FieldViewport,
  b: PlotBounds,
): [number, number] {
  return [
    b.left + b.width / 2 + (((x - view.x) * b.width) / 2) * view.zoom,
    b.top + b.height / 2 - (((y - view.y) * b.height) / 2) * view.zoom,
  ];
}
export function unproject(
  x: number,
  y: number,
  view: FieldViewport,
  b: PlotBounds,
): [number, number] {
  return [
    view.x + ((x - b.left - b.width / 2) * 2) / b.width / view.zoom,
    view.y - ((y - b.top - b.height / 2) * 2) / b.height / view.zoom,
  ];
}
export function zoomAt(
  view: FieldViewport,
  factor: number,
  x: number,
  y: number,
  b: PlotBounds,
): FieldViewport {
  const anchor = unproject(x, y, view, b),
    zoom = Math.max(1, Math.min(6, view.zoom * factor));
  return boundedView({
    zoom,
    x: anchor[0] - ((x - b.left - b.width / 2) * 2) / b.width / zoom,
    y: anchor[1] + ((y - b.top - b.height / 2) * 2) / b.height / zoom,
  });
}
export function panBy(
  view: FieldViewport,
  dx: number,
  dy: number,
  b: PlotBounds,
): FieldViewport {
  return boundedView({
    ...view,
    x: view.x - (dx * 2) / b.width / view.zoom,
    y: view.y + (dy * 2) / b.height / view.zoom,
  });
}
