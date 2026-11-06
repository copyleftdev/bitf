import * as THREE from "three";
import type { Coin, Frame, Node } from "./types";
import { networkPosition, phaseFor, type NetworkPoint } from "./networkLayout";
export type FieldMode = "network" | "metrics";
import {
  DEFAULT_VIEW,
  boundedView,
  panBy,
  project,
  zoomAt,
  type FieldViewport,
  type PlotBounds,
} from "./fieldViewport";

type Particle = {
  id: string;
  data: Node;
  x: number;
  y: number;
  oldX: number;
  oldY: number;
  sx: number;
  sy: number;
  r: number;
  color: THREE.Color;
  label: HTMLButtonElement;
  valid: boolean;
  visible: boolean;
  pulseAt: number;
};
type Link = {
  a: Particle;
  b: Particle;
  r: number;
  n: number;
  points: Float32Array;
  label: HTMLSpanElement;
  bend: number;
  hot: boolean;
};
export type RenderStats = {
  fps: number;
  calls: number;
  nodes: number;
  idle?: boolean;
};
const mint = new THREE.Color("#99f5d5"),
  coral = new THREE.Color("#ff8e87"),
  neutral = new THREE.Color("#91a6b1");
const dimColor = new THREE.Color("#405a60"),
  lineColor = new THREE.Color(),
  gridColor = new THREE.Color();
const SEGMENTS = 20,
  MAX_LINKS = 1250;

/** One renderer, fixed GPU buffers, screen-space marks and a bounded data camera. */
export class MarketField {
  renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 100);
  private particles: Particle[] = [];
  private ranked: Particle[] = [];
  private links: Link[] = [];
  private selected = "BTC-USD";
  private focused = false;
  private reduced = false;
  private mode: FieldMode = "network";
  private network = new Map<string, NetworkPoint>();
  private layoutKey = "";
  private layoutRevision = 0;
  private motionTime = 0;
  private worker = new Worker(
    new URL("./networkLayout.worker.ts", import.meta.url),
    { type: "module" },
  );
  private connected = new Set<string>();
  private width = 1;
  private height = 1;
  private bounds: PlotBounds = { left: 60, top: 36, width: 100, height: 100 };
  private view: FieldViewport = { ...DEFAULT_VIEW };
  private mesh: THREE.InstancedMesh;
  private halos: THREE.InstancedMesh;
  private rims: THREE.InstancedMesh;
  private alerts: THREE.InstancedMesh;
  private focusLines: THREE.InstancedMesh;
  private lines: THREE.LineSegments;
  private trails: THREE.LineSegments;
  private grid: THREE.LineSegments;
  private selection: THREE.LineLoop;
  private dummy = new THREE.Object3D();
  private labels: HTMLDivElement;
  private axes: HTMLDivElement;
  private tooltip: HTMLDivElement;
  private observer: ResizeObserver;
  private intersection: IntersectionObserver;
  private inView = true;
  private catalog: Map<string, Coin>;
  private linkCapacity = MAX_LINKS;
  private previousIndex = -1;
  private changedAt = 0;
  private wakeAt = 0;
  private lastTime = 0;
  private frames = 0;
  private elapsed = 0;
  private disposed = false;
  private lost = false;
  private hovered: Particle | null = null;
  private hoveredLink: Link | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number } | null = null;
  private moved = false;
  private pinched = false;
  private pinchDistance = 0;
  private abort = new AbortController();
  onStats?: (stats: RenderStats) => void;
  onView?: (view: FieldViewport) => void;

  constructor(
    private host: HTMLDivElement,
    catalog: Coin[],
    private onSelect: (id: string) => void,
    onFailure: () => void,
  ) {
    this.worker.onmessage = (
      event: MessageEvent<{ revision: number; points: NetworkPoint[] }>,
    ) => {
      if (this.disposed || event.data.revision !== this.layoutRevision) return;
      this.network = new Map(event.data.points.map((p) => [p.id, p]));
      this.changedAt = performance.now();
      this.wake();
    };
    this.worker.onerror = () => onFailure();
    this.catalog = new Map(catalog.map((c) => [c.id, c]));
    const qualifiedCount = catalog.filter((c) => c.qualified).length;
    this.linkCapacity = Math.max(1, Math.min(MAX_LINKS, qualifiedCount * 3));
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.setClearColor(0x080e12, 0);
    const canvas = this.renderer.domElement;
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      "Interactive market field. Arrows pan, plus and minus zoom, F focuses the selected coin, zero resets.",
    );
    host.appendChild(canvas);
    this.labels = document.createElement("div");
    this.labels.className = "field-labels";
    host.appendChild(this.labels);
    this.axes = document.createElement("div");
    this.axes.className = "field-axes";
    this.axes.setAttribute("aria-hidden", "true");
    host.appendChild(this.axes);
    this.tooltip = document.createElement("div");
    this.tooltip.className = "field-tooltip";
    this.tooltip.hidden = true;
    this.tooltip.setAttribute("role", "tooltip");
    host.appendChild(this.tooltip);
    this.mesh = this.instances(
      new THREE.CircleGeometry(1, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
      }),
      catalog.length,
    );
    this.rims = this.instances(
      new THREE.RingGeometry(1.3, 1.39, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
      catalog.length,
    );
    this.halos = this.instances(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        vertexShader:
          "varying vec2 vUv;varying vec3 vColor;void main(){vUv=uv;vColor=instanceColor;gl_Position=projectionMatrix*modelViewMatrix*instanceMatrix*vec4(position,1.);}",
        fragmentShader:
          "varying vec2 vUv;varying vec3 vColor;void main(){float d=length(vUv-.5)*2.;float a=exp(-d*d*6.)*.2*(1.-smoothstep(.7,1.,d));gl_FragColor=vec4(vColor,a);}",
      }),
      catalog.length,
    );
    this.halos.setColorAt(0, mint);
    this.alerts = this.instances(
      new THREE.RingGeometry(0.975, 1, 48),
      new THREE.MeshBasicMaterial({
        color: "#efb27b",
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
      catalog.length,
    );
    this.focusLines = this.instances(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      }),
      Math.max(1, qualifiedCount) * SEGMENTS,
    );
    this.lines = new THREE.LineSegments(
      this.lineGeometry(this.linkCapacity * SEGMENTS),
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.36,
        depthWrite: false,
      }),
    );
    this.trails = new THREE.LineSegments(
      this.lineGeometry(404),
      new THREE.LineBasicMaterial({
        color: "#99f5d5",
        transparent: true,
        opacity: 0.25,
        depthWrite: false,
      }),
    );
    this.grid = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.8,
      }),
    );
    const circle = [];
    for (let i = 0; i < 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      circle.push(Math.cos(a), Math.sin(a), 0);
    }
    this.selection = new THREE.LineLoop(
      new THREE.BufferGeometry().setAttribute(
        "position",
        new THREE.Float32BufferAttribute(circle, 3),
      ),
      new THREE.LineBasicMaterial({
        color: "#ecfff7",
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.selection.visible = false;
    this.scene.add(this.grid, this.lines, this.trails, this.selection);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.intersection = new IntersectionObserver(([entry]) => {
      this.inView = entry.isIntersecting;
      if (this.inView) this.wake();
      else {
        this.renderer.setAnimationLoop(null);
        this.lastTime = 0;
        this.frames = 0;
        this.elapsed = 0;
      }
    });
    this.intersection.observe(host);
    this.resize();
    const options = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", this.pointerDown, options);
    canvas.addEventListener("pointermove", this.pointerMove, options);
    canvas.addEventListener("pointerup", this.pointerUp, options);
    canvas.addEventListener("pointercancel", this.pointerCancel, options);
    canvas.addEventListener(
      "pointerleave",
      () => {
        if (!this.pointers.size) this.clearHover();
      },
      options,
    );
    host.addEventListener("wheel", this.wheel, { ...options, passive: false });
    canvas.addEventListener(
      "dblclick",
      (e) => {
        const p = this.hit(...this.local(e));
        if (p) {
          this.onSelect(p.id);
          this.focusCoin(p.id);
        } else this.zoom(1.6, ...this.local(e));
      },
      options,
    );
    canvas.addEventListener("keydown", this.keyDown, options);
    canvas.addEventListener(
      "webglcontextlost",
      (event) => {
        event.preventDefault();
        this.lost = true;
        this.renderer.setAnimationLoop(null);
        onFailure();
      },
      options,
    );
    document.addEventListener(
      "visibilitychange",
      () => {
        this.lastTime = 0;
        if (document.hidden) this.renderer.setAnimationLoop(null);
        else this.wake();
      },
      options,
    );
  }
  private instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    count: number,
  ) {
    const m = new THREE.InstancedMesh(geometry, material, count);
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(m);
    return m;
  }
  private lineGeometry(count: number) {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(count * 6), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    g.setAttribute(
      "color",
      new THREE.BufferAttribute(new Float32Array(count * 6), 3).setUsage(
        THREE.DynamicDrawUsage,
      ),
    );
    g.setDrawRange(0, 0);
    return g;
  }
  private local(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.host.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }
  private hit(x: number, y: number) {
    let nearest: Particle | null = null,
      distance = Infinity;
    for (const p of this.particles) {
      if (!p.visible) continue;
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (d < p.r + 9 && d < distance) {
        nearest = p;
        distance = d;
      }
    }
    return nearest;
  }
  private hitLink(x: number, y: number) {
    let best: Link | null = null,
      distance = 6;
    for (const link of this.links) {
      for (let i = 0; i < SEGMENTS; i++) {
        const ax = link.points[i * 2],
          ay = link.points[i * 2 + 1],
          dx = link.points[i * 2 + 2] - ax,
          dy = link.points[i * 2 + 3] - ay;
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1),
          ),
        );
        const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
        if (d < distance) {
          distance = d;
          best = link;
        }
      }
    }
    return best;
  }
  private inside(x: number, y: number) {
    const b = this.bounds;
    return (
      x >= b.left &&
      x <= b.left + b.width &&
      y >= b.top &&
      y <= b.top + b.height
    );
  }
  private pointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const [x, y] = this.local(e);
    this.renderer.domElement.focus({ preventScroll: true });
    this.renderer.domElement.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x, y });
    this.clearHover();
    if (this.pointers.size === 1) {
      this.down = { x, y };
      this.moved = false;
      this.pinched = false;
    }
    if (this.pointers.size === 2) {
      this.pinched = true;
      const [a, b] = [...this.pointers.values()];
      this.pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    }
    this.host.classList.add("dragging");
  };
  private pointerMove = (e: PointerEvent) => {
    const [x, y] = this.local(e),
      previous = this.pointers.get(e.pointerId);
    if (previous) {
      this.pointers.set(e.pointerId, { x, y });
      if (this.down && Math.hypot(x - this.down.x, y - this.down.y) > 4)
        this.moved = true;
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()],
          distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDistance > 0)
          this.zoom(
            distance / this.pinchDistance,
            (a.x + b.x) / 2,
            (a.y + b.y) / 2,
          );
        this.pinchDistance = distance;
      } else
        this.setView(
          panBy(this.view, x - previous.x, y - previous.y, this.bounds),
        );
      return;
    }
    if (!this.inside(x, y)) {
      this.clearHover();
      return;
    }
    const node = this.hit(x, y),
      link = node ? null : this.hitLink(x, y);
    if (node !== this.hovered || link !== this.hoveredLink) {
      this.hovered = node;
      this.hoveredLink = link;
      this.wake();
    }
    this.host.style.cursor = node
      ? "pointer"
      : link
        ? "help"
        : this.view.zoom > 1
          ? "grab"
          : "crosshair";
    if (node || link) {
      this.tooltip.hidden = false;
      this.tooltip.replaceChildren();
      const title = document.createElement("strong"),
        detail = document.createElement("span");
      if (node) {
        title.textContent = node.id.replace("-", " / ");
        detail.textContent = `${node.data.return1h === null ? "—" : (node.data.return1h >= 0 ? "+" : "") + node.data.return1h.toFixed(2) + "%"} · 1h   /   ${node.data.activity?.toFixed(2) ?? "—"}× activity`;
      } else if (link) {
        title.textContent = `${link.a.id.replace("-USD", "")} ↔ ${link.b.id.replace("-USD", "")}`;
        detail.textContent = `r ${link.r >= 0 ? "+" : ""}${link.r.toFixed(2)} · ${link.n} paired 5m returns / 4h`;
      }
      this.tooltip.append(title, detail);
      this.tooltip.style.left = `${Math.max(12, Math.min(x + 17, this.width - 275))}px`;
      this.tooltip.style.top = `${Math.max(10, Math.min(y - 65, this.height - 78))}px`;
    } else this.tooltip.hidden = true;
  };
  private pointerUp = (e: PointerEvent) => {
    const [x, y] = this.local(e);
    if (!this.moved && !this.pinched) {
      const p = this.hit(x, y);
      if (p) this.onSelect(p.id);
    }
    this.pointers.delete(e.pointerId);
    if (this.renderer.domElement.hasPointerCapture(e.pointerId))
      this.renderer.domElement.releasePointerCapture(e.pointerId);
    if (!this.pointers.size) {
      this.down = null;
      this.host.classList.remove("dragging");
    }
  };
  private pointerCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    this.moved = true;
    if (!this.pointers.size) {
      this.down = null;
      this.host.classList.remove("dragging");
    }
  };
  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.local(e);
    this.zoom(
      Math.exp(
        -Math.max(
          -180,
          Math.min(180, e.deltaY * (e.deltaMode === 1 ? 16 : 1)),
        ) * 0.003,
      ),
      x,
      y,
    );
  };
  private keyDown = (e: KeyboardEvent) => {
    // Preserve browser zoom/reset and platform navigation shortcuts.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    let handled = true;
    switch (e.key) {
      case "+":
      case "=":
        this.zoom(1.3);
        break;
      case "-":
        this.zoom(1 / 1.3);
        break;
      case "0":
        this.reset();
        break;
      case "f":
      case "F":
        this.focusCoin();
        break;
      case "ArrowLeft":
        this.setView(panBy(this.view, 45, 0, this.bounds));
        break;
      case "ArrowRight":
        this.setView(panBy(this.view, -45, 0, this.bounds));
        break;
      case "ArrowUp":
        this.setView(panBy(this.view, 0, 45, this.bounds));
        break;
      case "ArrowDown":
        this.setView(panBy(this.view, 0, -45, this.bounds));
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
  private clearHover() {
    this.tooltip.hidden = true;
    if (this.hovered || this.hoveredLink) {
      this.hovered = null;
      this.hoveredLink = null;
      this.wake();
    }
  }
  private wake() {
    if (this.disposed || this.lost) return;
    this.wakeAt = performance.now();
    if (!document.hidden && this.inView)
      this.renderer.setAnimationLoop(this.animate);
  }
  private setView(next: FieldViewport) {
    this.view = boundedView(next);
    this.clearHover();
    this.updateAxes();
    this.onView?.({ ...this.view });
    this.wake();
  }
  zoom(
    factor: number,
    x = this.bounds.left + this.bounds.width / 2,
    y = this.bounds.top + this.bounds.height / 2,
  ) {
    this.setView(zoomAt(this.view, factor, x, y, this.bounds));
  }
  reset() {
    this.setView({ ...DEFAULT_VIEW });
  }
  focusCoin(id = this.selected) {
    const p = this.particles.find((p) => p.id === id);
    if (p?.valid) this.setView({ zoom: 2.5, x: p.x, y: p.y });
  }
  private resize() {
    // Browser viewport transitions can briefly report a zero- or one-pixel host. Keep
    // the last valid projection until layout supplies real dimensions again.
    if (this.host.clientWidth <= 1 || this.host.clientHeight <= 1) return;
    this.width = Math.max(1, this.host.clientWidth);
    this.height = Math.max(1, this.host.clientHeight);
    this.bounds = {
      left: this.width < 550 ? 48 : 64,
      top: 36,
      width: Math.max(30, this.width - (this.width < 550 ? 78 : 108)),
      height: Math.max(30, this.height - (this.width < 550 ? 152 : 126)),
    };
    this.renderer.setSize(this.width, this.height);
    this.camera.left = -this.width / 2;
    this.camera.right = this.width / 2;
    this.camera.top = this.height / 2;
    this.camera.bottom = -this.height / 2;
    this.camera.updateProjectionMatrix();
    this.updateAxes();
    this.wake();
  }
  private updateAxes() {
    const vertices: number[] = [],
      colors: number[] = [],
      b = this.bounds,
      v = this.view;
    this.axes.replaceChildren();
    this.grid.visible = this.mode === "metrics";
    this.labels.style.clipPath = `inset(${b.top - 17}px ${this.width - b.left - b.width - 26}px ${this.height - b.top - b.height - 17}px ${b.left - 20}px)`;
    if (this.mode === "network") return;
    const tick = (text: string, x: number, y: number, kind: string) => {
      const element = document.createElement("span");
      element.className = `field-tick ${kind}`;
      element.textContent = text;
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      this.axes.appendChild(element);
    };
    const segment = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      emphasis: boolean,
    ) => {
      vertices.push(
        x1 - this.width / 2,
        this.height / 2 - y1,
        -8,
        x2 - this.width / 2,
        this.height / 2 - y2,
        -8,
      );
      gridColor.set(emphasis ? "#39535b" : "#1d2c34");
      colors.push(
        gridColor.r,
        gridColor.g,
        gridColor.b,
        gridColor.r,
        gridColor.g,
        gridColor.b,
      );
    };
    const xStep = v.zoom < 1.6 ? 1 : v.zoom < 3 ? 0.5 : 0.25;
    const minX = (v.x - 1 / v.zoom) * 4,
      maxX = (v.x + 1 / v.zoom) * 4;
    for (
      let value = Math.ceil((minX - 1e-6) / xStep) * xStep;
      value <= maxX + 1e-6;
      value += xStep
    ) {
      const [x] = project(value / 4, 0, v, b);
      segment(x, b.top, x, b.top + b.height, Math.abs(value) < 0.001);
      tick(
        `${value > 0 ? "+" : ""}${Number(value.toFixed(2))}${Math.abs(value) > 0.001 ? "%" : ""}`,
        x,
        b.top + b.height + 15,
        "tick-x",
      );
    }
    const yStep = v.zoom < 1.8 ? 1 : v.zoom < 3.5 ? 0.5 : 0.25;
    const minY = (v.y - 1 / v.zoom) * 4 + 2,
      maxY = (v.y + 1 / v.zoom) * 4 + 2;
    for (
      let exponent = Math.ceil((minY - 1e-6) / yStep) * yStep;
      exponent <= maxY + 1e-6;
      exponent += yStep
    ) {
      const [, y] = project(0, (exponent - 2) / 4, v, b),
        value = 2 ** exponent;
      segment(b.left, y, b.left + b.width, y, Math.abs(exponent) < 0.001);
      tick(
        `${Number(value.toFixed(value >= 10 ? 0 : value >= 1 ? 1 : 2))}×`,
        b.left - 12,
        y,
        "tick-y",
      );
    }
    this.grid.geometry.dispose();
    this.grid.geometry = new THREE.BufferGeometry()
      .setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3))
      .setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    this.labels.style.clipPath = `inset(${b.top - 17}px ${this.width - b.left - b.width - 26}px ${this.height - b.top - b.height - 17}px ${b.left - 20}px)`;
  }
  update(
    frame: Frame,
    selected: string,
    all: boolean,
    focused: boolean,
    reduced: boolean,
    minR = 0.65,
    mode: FieldMode = "network",
    frozen = false,
  ) {
    this.clearHover();
    const changed = frame.index !== this.previousIndex;
    this.selected = selected;
    this.focused = focused;
    this.reduced = reduced || frozen;
    if (this.mode !== mode) {
      this.mode = mode;
      this.changedAt = performance.now();
      this.reset();
    }
    const old = new Map(this.particles.map((p) => [p.id, p]));
    this.particles = frame.nodes
      .filter(
        (n) => all || this.catalog.get(n.id)?.qualified || n.id === selected,
      )
      .map((node) => {
        const prior = old.get(node.id);
        old.delete(node.id);
        const label = prior?.label ?? document.createElement("button");
        if (!prior) {
          label.className = "node-label";
          label.textContent = this.catalog.get(node.id)!.symbol;
          label.tabIndex = -1;
          label.setAttribute("aria-label", `Inspect ${node.id}`);
          label.onclick = () => this.onSelect(node.id);
          label.ondblclick = () => this.focusCoin(node.id);
          this.labels.appendChild(label);
        }
        label.classList.toggle("selected", node.id === selected);
        label.classList.toggle("alerted", node.alerts.length > 0);
        const valid =
          mode === "network" && frame.live
            ? node.price !== null
            : node.x !== null && node.y !== null;
        const x = valid ? (prior?.valid ? prior.x : (node.x ?? 0)) : 0,
          y = valid ? (prior?.valid ? prior.y : (node.y ?? 0)) : 0;
        return {
          id: node.id,
          data: node,
          pulseAt:
            node.tick !== undefined && node.tick !== prior?.data.tick
              ? performance.now()
              : (prior?.pulseAt ?? 0),
          x,
          y,
          oldX: changed ? x : (prior?.oldX ?? x),
          oldY: changed ? y : (prior?.oldY ?? y),
          sx: 0,
          sy: 0,
          r: 6,
          color:
            node.return1h === null
              ? neutral
              : node.return1h >= 0
                ? mint
                : coral,
          label,
          valid,
          visible: false,
        };
      });
    old.forEach((p) => p.label.remove());
    this.links.forEach((l) => l.label.remove());
    this.connected.clear();
    const map = new Map(this.particles.map((p) => [p.id, p]));
    this.links = frame.edges
      .filter(
        (e) =>
          Math.abs(e.r) >= minR &&
          map.get(e.a)?.valid &&
          map.get(e.b)?.valid &&
          (!focused || e.a === selected || e.b === selected),
      )
      .slice(0, this.linkCapacity)
      .map((e) => {
        const hot = e.a === selected || e.b === selected;
        if (hot) this.connected.add(e.a === selected ? e.b : e.a);
        const label = document.createElement("span");
        label.className = `edge-label${e.r < 0 ? " negative" : ""}`;
        label.textContent = `${e.r > 0 ? "+" : ""}${e.r.toFixed(2)}`;
        label.title = `4h Pearson correlation; ${e.n} paired returns`;
        this.labels.appendChild(label);
        const hash = [...(e.a + e.b)].reduce((s, c) => s + c.charCodeAt(0), 0);
        return {
          a: map.get(e.a)!,
          b: map.get(e.b)!,
          r: e.r,
          n: e.n,
          points: new Float32Array((SEGMENTS + 1) * 2),
          label,
          bend: (hash % 2 ? 1 : -1) * (0.1 + (hash % 3) * 0.025),
          hot,
        };
      })
      .sort(
        (a, b) =>
          Number(b.hot) - Number(a.hot) || Math.abs(b.r) - Math.abs(a.r),
      );
    if (mode === "network") {
      const ids = this.particles.filter((p) => p.valid).map((p) => p.id);
      const eligible = new Set(ids);
      // Selection/focus affects emphasis only, never the underlying layout.
      const edges = frame.edges.filter(
        (e) => Math.abs(e.r) >= minR && eligible.has(e.a) && eligible.has(e.b),
      );
      const key = JSON.stringify([
        ids,
        edges.map((e) => [e.a, e.b, e.r.toFixed(3)]),
      ]);
      if (key !== this.layoutKey) {
        this.layoutKey = key;
        this.worker.postMessage({
          revision: ++this.layoutRevision,
          ids,
          edges,
        });
      }
    }
    this.ranked = [...this.particles].sort(
      (a, b) =>
        Number(b.id === selected) - Number(a.id === selected) ||
        Number(this.connected.has(b.id)) - Number(this.connected.has(a.id)) ||
        (b.data.turnover1h || 0) - (a.data.turnover1h || 0),
    );
    this.mesh.count =
      this.rims.count =
      this.halos.count =
        this.particles.length;
    if (changed) {
      this.changedAt = performance.now();
      this.clearHover();
    }
    this.previousIndex = frame.index;
    this.wake();
  }
  private pose(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    r: number,
    z = 0,
  ) {
    this.dummy.position.set(x - this.width / 2, this.height / 2 - y, z);
    this.dummy.rotation.z = 0;
    this.dummy.scale.set(r, r, 1);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }
  private layoutLabels() {
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    let count = 0;
    const cap = Math.min(
      64,
      Math.round((this.width < 550 ? 12 : 24) * Math.sqrt(this.view.zoom)),
    );
    const ordered = this.hovered
      ? [this.hovered, ...this.ranked.filter((p) => p !== this.hovered)]
      : this.ranked;
    for (const p of ordered) {
      p.label.style.display = "none";
      if (!p.visible || count >= cap) continue;
      const w = this.catalog.get(p.id)!.symbol.length * 7 + 12,
        h = 18;
      const options = [
        [p.sx + p.r + 8, p.sy - 9],
        [p.sx - p.r - w - 8, p.sy - 9],
        [p.sx - w / 2, p.sy - p.r - 24],
        [p.sx - w / 2, p.sy + p.r + 7],
      ];
      for (const [x, y] of options) {
        if (
          x < this.bounds.left - 16 ||
          x + w > this.bounds.left + this.bounds.width + 23 ||
          y < this.bounds.top - 15 ||
          y + h > this.bounds.top + this.bounds.height + 13
        )
          continue;
        if (
          occupied.some(
            (o) =>
              x < o.x + o.w + 6 &&
              x + w + 6 > o.x &&
              y < o.y + o.h + 3 &&
              y + h + 3 > o.y,
          )
        )
          continue;
        p.label.style.display = "block";
        p.label.style.transform = `translate(${x}px,${y}px)`;
        p.label.classList.toggle("connected", this.connected.has(p.id));
        occupied.push({ x, y, w, h });
        count++;
        break;
      }
    }
    let edgeCount = 0;
    for (const link of this.links) {
      link.label.style.display = "none";
      if (!link.hot || edgeCount >= 4 || this.view.zoom < 1.3) continue;
      const x = link.points[SEGMENTS] - 18,
        y = link.points[SEGMENTS + 1] - 9,
        w = 36,
        h = 17;
      if (
        !this.inside(x - 4, y - 4) ||
        !this.inside(x + w + 4, y + h + 4) ||
        occupied.some(
          (o) =>
            x < o.x + o.w + 7 &&
            x + w + 7 > o.x &&
            y < o.y + o.h + 5 &&
            y + h + 5 > o.y,
        )
      )
        continue;
      occupied.push({ x, y, w, h });
      link.label.style.display = "block";
      link.label.style.transform = `translate(${x}px,${y}px)`;
      edgeCount++;
    }
  }
  private animate = (time: number) => {
    if (this.disposed || this.lost) return;
    const delta = this.lastTime
      ? Math.min((time - this.lastTime) / 1000, 0.05)
      : 1 / 60;
    if (this.lastTime) {
      this.elapsed += time - this.lastTime;
      this.frames++;
    }
    this.lastTime = time;
    const ease = this.reduced ? 1 : 1 - Math.exp(-delta * 5),
      nodeScale =
        (this.width < 550 ? 0.78 : 1) *
        Math.min(1.5, Math.sqrt(this.view.zoom));
    if (this.mode === "network" && !this.reduced) this.motionTime += delta;
    let alertIndex = 0,
      trailIndex = 0;
    const trailPositions = this.trails.geometry.attributes
      .position as THREE.BufferAttribute;
    this.selection.visible = false;
    this.particles.forEach((p, i) => {
      if (p.valid) {
        const anchor = this.network.get(p.id);
        const [tx, ty] =
          this.mode === "network" && anchor
            ? networkPosition(anchor, this.motionTime)
            : [p.data.x ?? 0, p.data.y ?? 0];
        p.x += (tx - p.x) * ease;
        p.y += (ty - p.y) * ease;
        [p.sx, p.sy] = project(p.x, p.y, this.view, this.bounds);
      }
      p.visible = p.valid && this.inside(p.sx, p.sy);
      p.r =
        Math.sqrt(5 + 5 * Math.log10(1 + (p.data.turnover1h || 0))) * nodeScale;
      const hot = p.id === this.selected || p === this.hovered,
        dim = this.focused && !hot && !this.connected.has(p.id),
        r = p.valid ? p.r : 0;
      this.pose(this.mesh, i, p.sx, p.sy, r, 0);
      this.mesh.setColorAt(i, dim ? dimColor : p.color);
      this.pose(this.rims, i, p.sx, p.sy, r, 1);
      this.rims.setColorAt(i, hot ? mint : dim ? dimColor : p.color);
      const tickPulse = this.reduced
        ? 0
        : Math.max(0, 1 - (time - p.pulseAt) / 800);
      this.pose(
        this.halos,
        i,
        p.sx,
        p.sy,
        dim ? 0 : r * ((hot ? 5 : 3.5) + tickPulse * 2.5),
        -2,
      );
      this.halos.setColorAt(i, p.color);
      if (p.valid && p.data.alerts.length) {
        const pulse = this.reduced
          ? 0
          : Math.min((time - this.changedAt) / 1400, 1);
        this.pose(
          this.alerts,
          alertIndex++,
          p.sx,
          p.sy,
          r + 4 + pulse * 5,
          0.5,
        );
      }
      if (this.mode === "metrics" && p.valid && time - this.changedAt < 2200) {
        const [x, y] = project(p.oldX, p.oldY, this.view, this.bounds);
        trailPositions.setXYZ(
          trailIndex * 2,
          x - this.width / 2,
          this.height / 2 - y,
          -1,
        );
        trailPositions.setXYZ(
          trailIndex * 2 + 1,
          p.sx - this.width / 2,
          this.height / 2 - p.sy,
          -1,
        );
        trailIndex++;
      }
      if (p.valid && p.id === this.selected) {
        this.selection.visible = true;
        this.selection.position.set(
          p.sx - this.width / 2,
          this.height / 2 - p.sy,
          2,
        );
        this.selection.scale.setScalar(r + 6);
      }
    });
    this.trails.geometry.setDrawRange(0, trailIndex * 2);
    trailPositions.needsUpdate = true;
    this.alerts.count = alertIndex;
    this.alerts.instanceMatrix.needsUpdate = true;
    const positions = this.lines.geometry.attributes
        .position as THREE.BufferAttribute,
      colors = this.lines.geometry.attributes.color as THREE.BufferAttribute;
    let bg = 0,
      fg = 0;
    for (const link of this.links) {
      const a = link.a,
        b = link.b,
        dx = b.sx - a.sx,
        dy = b.sy - a.sy,
        phase = phaseFor(a.id + b.id),
        bend =
          link.bend +
          (this.mode === "network"
            ? 0.045 * Math.sin(this.motionTime * 0.32 + phase)
            : 0),
        cx = (a.sx + b.sx) / 2 - dy * bend,
        cy = (a.sy + b.sy) / 2 + dx * bend;
      const emphasis = link.hot || link === this.hoveredLink;
      const c = link.r < 0 ? coral : mint;
      for (let s = 0; s <= SEGMENTS; s++) {
        const t = s / SEGMENTS,
          u = 1 - t;
        link.points[s * 2] = u * u * a.sx + 2 * u * t * cx + t * t * b.sx;
        link.points[s * 2 + 1] = u * u * a.sy + 2 * u * t * cy + t * t * b.sy;
      }
      for (let s = 0; s < SEGMENTS; s++) {
        if (link.r < 0 && s % 3 === 2) continue;
        const x1 = link.points[s * 2],
          y1 = link.points[s * 2 + 1],
          x2 = link.points[s * 2 + 2],
          y2 = link.points[s * 2 + 3];
        if (emphasis) {
          this.dummy.position.set(
            (x1 + x2) / 2 - this.width / 2,
            this.height / 2 - (y1 + y2) / 2,
            -3,
          );
          this.dummy.rotation.z = Math.atan2(y1 - y2, x2 - x1);
          this.dummy.scale.set(
            Math.hypot(x2 - x1, y2 - y1) + 0.5,
            link === this.hoveredLink ? 2.2 : 1.1 + Math.abs(link.r) * 0.7,
            1,
          );
          this.dummy.updateMatrix();
          this.focusLines.setMatrixAt(fg, this.dummy.matrix);
          this.focusLines.setColorAt(fg++, c);
        } else {
          positions.setXYZ(
            bg * 2,
            x1 - this.width / 2,
            this.height / 2 - y1,
            -4,
          );
          positions.setXYZ(
            bg * 2 + 1,
            x2 - this.width / 2,
            this.height / 2 - y2,
            -4,
          );
          lineColor
            .copy(c)
            .multiplyScalar(
              (this.mode === "network" ? 0.18 : 0.14) * (1 + Math.abs(link.r)),
            );
          colors.setXYZ(bg * 2, lineColor.r, lineColor.g, lineColor.b);
          colors.setXYZ(bg * 2 + 1, lineColor.r, lineColor.g, lineColor.b);
          bg++;
        }
      }
    }
    this.lines.geometry.setDrawRange(0, bg * 2);
    positions.addUpdateRange(0, bg * 6);
    colors.addUpdateRange(0, bg * 6);
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    this.focusLines.count = fg;
    this.focusLines.instanceMatrix.addUpdateRange(0, fg * 16);
    this.focusLines.instanceColor?.addUpdateRange(0, fg * 3);
    this.focusLines.instanceMatrix.needsUpdate = true;
    if (this.focusLines.instanceColor)
      this.focusLines.instanceColor.needsUpdate = true;
    for (const mesh of [this.mesh, this.rims, this.halos]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.layoutLabels();
    const b = this.bounds;
    this.renderer.setScissor(
      b.left - 12,
      this.height - b.top - b.height - 12,
      b.width + 24,
      b.height + 24,
    );
    this.renderer.setScissorTest(true);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
    if (
      (this.mode === "metrics" || this.reduced) &&
      time - this.changedAt > 2200 &&
      time - this.wakeAt > 160
    ) {
      this.renderer.setAnimationLoop(null);
      this.onStats?.({
        fps: 0,
        calls: this.renderer.info.render.calls,
        nodes: this.particles.length,
        idle: true,
      });
      this.lastTime = 0;
      this.frames = 0;
      this.elapsed = 0;
      return;
    }
    if (this.frames >= 60) {
      this.onStats?.({
        fps: Math.round((this.frames * 1000) / this.elapsed),
        calls: this.renderer.info.render.calls,
        nodes: this.particles.length,
      });
      this.frames = 0;
      this.elapsed = 0;
    }
  };
  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.abort.abort();
    this.worker.terminate();
    this.observer.disconnect();
    this.intersection.disconnect();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(
          (m) => m.dispose(),
        );
      }
      if (obj instanceof THREE.InstancedMesh) obj.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.remove();
    this.axes.remove();
    this.tooltip.remove();
  }
}
