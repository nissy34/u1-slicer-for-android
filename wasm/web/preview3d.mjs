// three.js viewer for the page: the U1 bed, the loaded model (engine Prepare
// mesh per object, coloured per extruder slot, draggable on the bed together
// with the prime-tower footprint) and the sliced G-code (extrusion lines,
// coloured by feature or by tool, clipped to a layer range).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const BED = 270; // Snapmaker U1 bed / height, mm

// Default slot colours (E1–E4), then extra colours for painted files with >4 states.
export const SLOT_COLORS = ['#e8e8e8', '#e53935', '#1e88e5', '#fdd835', '#43a047', '#8e24aa', '#fb8c00', '#00acc1'];

export const FEATURE_COLORS = {
  'Outer wall': '#ff7d38', 'Inner wall': '#ffe24a', 'Overhang wall': '#3b5bdb',
  'Sparse infill': '#b03029', 'Internal solid infill': '#9654c9', 'Top surface': '#f0505a',
  'Bottom surface': '#6a8d55', Bridge: '#4d80ba', 'Internal Bridge': '#4d80ba', 'Gap infill': '#ffffff',
  Skirt: '#00876e', Brim: '#00876e', Support: '#3fb950', 'Support interface': '#2f8a3b',
  'Support transition': '#2f8a3b', 'Prime tower': '#a0a0a0', Ironing: '#ff8c96', Custom: '#5ec2c2',
  Other: '#9e9e9e',
};

export class Preview3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    // Z-up to match printer coordinates.
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(BED / 2, -BED * 0.9, BED * 0.9);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(BED / 2, BED / 2, 0);
    this.controls.update();
    // Re-fit on resize until the user takes over the camera.
    this.fitBounds = null;
    this.controls.addEventListener('start', () => { this.fitBounds = null; });

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(BED, -BED, BED * 2);
    this.scene.add(sun);

    this.bed = this.#makeBed();
    this.scene.add(this.bed);
    this.modelGroup = null;
    this.objectMeshes = [];
    this.towerMesh = null;
    this.gcodeLines = null;
    this.gcode = null;

    new ResizeObserver(() => this.#resize()).observe(container);
    this.#resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setTheme({ background, grid }) {
    this.scene.background = new THREE.Color(background);
    this.bed.children.forEach((c) => c.material?.color?.set(grid));
  }

  #makeBed() {
    const g = new THREE.Group();
    const grid = new THREE.GridHelper(BED, 27, 0x888888, 0x888888);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(BED / 2, BED / 2, 0);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    g.add(grid);
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(BED, BED, 0.01)),
      new THREE.LineBasicMaterial({ color: 0x888888 }));
    edge.position.set(BED / 2, BED / 2, 0);
    g.add(edge);
    return g;
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.fitBounds) this.#frame(this.fitBounds);
  }

  #clear(obj) {
    if (!obj) return;
    this.scene.remove(obj);
    obj.geometry.dispose();
    obj.material.dispose();
  }

  #frame(bounds) {
    const [x0, y0, z0, x1, y1, z1] = bounds;
    const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    // Fit the bounding sphere to the narrower of the two fields of view.
    const radius = Math.max(10, 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0));
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * this.camera.aspect);
    const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05;
    const dir = new THREE.Vector3(0.45, -0.75, 0.55).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.update();
    this.fitBounds = bounds;
  }

  #clearModel() {
    if (!this.modelGroup) return;
    this.scene.remove(this.modelGroup);
    this.modelGroup.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.modelGroup = null;
    this.objectMeshes = [];
    this.towerMesh = null;
  }

  /**
   * mesh: { positions: Float32Array (9/tri), extruders: Uint8Array,
   *         objectTriangles?: Int32Array (per engine object, in mesh order), modifierStart? }
   * opts.tower: { x, y, w, d, h } prime-tower footprint (lower-left, mm) or null
   * opts.reframe: re-fit the camera (new model) — edits keep the user's view
   */
  showModel(mesh, slotColors = SLOT_COLORS, { tower = null, reframe = true } = {}) {
    this.#clearModel();
    this.modelGroup = new THREE.Group();
    this.scene.add(this.modelGroup);
    const tris = mesh.extruders.length;
    const palette = slotColors.map((c) => new THREE.Color(c));
    // One mesh per engine object so objects can be picked and dragged; the
    // trailing negative-volume block (F95) is drawn translucent like the app.
    const modelTris = mesh.modifierStart >= 0 ? mesh.modifierStart : tris;
    const counts = mesh.objectTriangles?.length ? [...mesh.objectTriangles] : [modelTris];
    let start = 0;
    counts.forEach((count, objIndex) => {
      if (count > 0) this.objectMeshes.push(this.#objectMesh(mesh, palette, start, count, objIndex));
      start += count;
    });
    if (start < modelTris) this.objectMeshes.push(this.#objectMesh(mesh, palette, start, modelTris - start, -1));
    if (modelTris < tris) {
      const m = this.#objectMesh(mesh, [new THREE.Color('#b0b0b0')], modelTris, tris - modelTris, -1);
      m.material.transparent = true;
      m.material.opacity = 0.35;
      m.material.depthWrite = false;
      m.userData.pickable = false;
    }
    if (tower) this.setTower(tower);
    const box = new THREE.Box3().setFromObject(this.modelGroup);
    if (reframe && !box.isEmpty()) this.#frame([box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);
    this.setMode('model');
  }

  #objectMesh(mesh, palette, start, count, objIndex) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(start * 9, (start + count) * 9), 3));
    const col = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      const c = palette[mesh.extruders[start + t] % palette.length];
      for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], t * 9 + v * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, flatShading: true,
    }));
    m.userData = { objIndex, pickable: objIndex >= 0 };
    this.modelGroup.add(m);
    return m;
  }

  /** Prime-tower footprint box ({ x, y, w, d, h }, lower-left mm), or null to hide. */
  setTower(tower) {
    if (this.towerMesh) {
      this.modelGroup?.remove(this.towerMesh);
      this.towerMesh.geometry.dispose();
      this.towerMesh.material.dispose();
      this.towerMesh = null;
    }
    if (!tower || !this.modelGroup) return;
    const h = Math.max(tower.h, 2);
    this.towerMesh = new THREE.Mesh(new THREE.BoxGeometry(tower.w, tower.d, h),
      new THREE.MeshStandardMaterial({ color: 0x9e9e9e, transparent: true, opacity: 0.55, roughness: 0.9 }));
    this.towerMesh.position.set(tower.x + tower.w / 2, tower.y + tower.d / 2, h / 2);
    this.towerMesh.userData = { tower: true, pickable: true, w: tower.w, d: tower.d };
    this.modelGroup.add(this.towerMesh);
  }

  /** Outline the selected object (index into the engine objects, or null). */
  setSelected(objIndex) {
    for (const m of this.objectMeshes) m.material.emissive?.set(m.userData.objIndex === objIndex ? 0x333333 : 0x000000);
  }

  /**
   * Pointer drag on the bed plane. opts.canDrag(hit) -> 'object' | 'group' | 'tower' | null;
   * opts.bounds(kind, objIndex) -> [minDx, maxDx, minDy, maxDy] limits for the move;
   * opts.onDrop({ kind, objIndex, dx, dy }) and opts.onPick(objIndex | null) on click.
   */
  enableDrag(opts) {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const ndc = new THREE.Vector2();
    const bedPoint = (e) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      return ray.ray.intersectPlane(plane, new THREE.Vector3());
    };
    let drag = null;
    el.addEventListener('pointerdown', (e) => {
      if (!this.modelGroup?.visible || e.button !== 0) return;
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const targets = this.modelGroup.children.filter((m) => m.userData.pickable);
      const hit = ray.intersectObjects(targets, false)[0]?.object ?? null;
      const kind = hit ? opts.canDrag(hit.userData.tower ? { tower: true } : { objIndex: hit.userData.objIndex }) : null;
      const start = bedPoint(e);
      if (!kind || !start) { drag = { kind: null, x: e.clientX, y: e.clientY }; return; }
      const objIndex = hit.userData.objIndex ?? null;
      const moving = kind === 'tower' ? [this.towerMesh] : kind === 'group' ? this.objectMeshes : this.objectMeshes.filter((m) => m.userData.objIndex === objIndex);
      drag = { kind, objIndex, start, moving, base: moving.map((m) => m.position.clone()), limits: opts.bounds(kind, objIndex), dx: 0, dy: 0, x: e.clientX, y: e.clientY };
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag?.kind) return;
      const p = bedPoint(e);
      if (!p) return;
      const [x0, x1, y0, y1] = drag.limits;
      drag.dx = Math.min(Math.max(p.x - drag.start.x, x0), x1);
      drag.dy = Math.min(Math.max(p.y - drag.start.y, y0), y1);
      drag.moving.forEach((m, i) => m.position.set(drag.base[i].x + drag.dx, drag.base[i].y + drag.dy, drag.base[i].z));
    });
    const end = (e) => {
      if (!drag) return;
      const d = drag;
      drag = null;
      this.controls.enabled = true;
      const clicked = Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4;
      if (clicked) {
        d.moving?.forEach((m, i) => m.position.copy(d.base[i]));
        if (d.kind !== 'tower') opts.onPick?.(d.objIndex ?? null);
        return;
      }
      if (d.kind && (d.dx || d.dy)) opts.onDrop({ kind: d.kind, objIndex: d.objIndex, dx: d.dx, dy: d.dy });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** preview: output of parseGcodePreview(); colorBy: 'feature' | 'tool' */
  showGcode(preview, colorBy = 'feature', slotColors = SLOT_COLORS) {
    this.#clear(this.gcodeLines);
    this.gcode = preview;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(preview.segments * 6), 3));
    this.gcodeLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.gcodeLines);
    this.recolorGcode(colorBy, slotColors);
    this.#frame(preview.bounds);
    this.setMode('gcode');
    this.setLayer(preview.layerEnds.length - 1);
  }

  recolorGcode(colorBy, slotColors = SLOT_COLORS) {
    if (!this.gcodeLines) return;
    const p = this.gcode, attr = this.gcodeLines.geometry.getAttribute('color');
    const names = self.GCODE_FEATURES;
    const featPalette = names.map((n) => new THREE.Color(FEATURE_COLORS[n] ?? FEATURE_COLORS.Other));
    const toolPalette = slotColors.map((c) => new THREE.Color(c));
    for (let s = 0; s < p.segments; s++) {
      const c = colorBy === 'tool' ? toolPalette[p.tools[s] % toolPalette.length] : featPalette[p.features[s]];
      attr.array.set([c.r, c.g, c.b, c.r, c.g, c.b], s * 6);
    }
    attr.needsUpdate = true;
  }

  /** Show layers [0, layer] of the G-code. */
  setLayer(layer) {
    if (!this.gcodeLines) return;
    const ends = this.gcode.layerEnds;
    const i = Math.max(0, Math.min(layer, ends.length - 1));
    this.gcodeLines.geometry.setDrawRange(0, (ends[i] ?? this.gcode.segments) * 2);
  }

  setMode(mode) {
    if (this.modelGroup) this.modelGroup.visible = mode === 'model';
    if (this.gcodeLines) this.gcodeLines.visible = mode === 'gcode';
  }
}
