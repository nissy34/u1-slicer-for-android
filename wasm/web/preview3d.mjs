// three.js viewer for the demo: the U1 bed, the loaded model (engine Prepare
// mesh, coloured per extruder slot) and the sliced G-code (extrusion lines,
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

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(BED, -BED, BED * 2);
    this.scene.add(sun);

    this.bed = this.#makeBed();
    this.scene.add(this.bed);
    this.modelMesh = null;
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
    const r = Math.max(x1 - x0, y1 - y0, z1 - z0, 20);
    this.controls.target.copy(c);
    this.camera.position.set(c.x + r * 0.9, c.y - r * 1.4, c.z + r * 1.1);
    this.controls.update();
  }

  /** mesh: { positions: Float32Array (9/tri), extruders: Uint8Array } */
  showModel(mesh, slotColors = SLOT_COLORS) {
    this.#clear(this.modelMesh);
    this.modelMesh = null;
    const tris = mesh.extruders.length;
    if (!tris) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    const col = new Float32Array(tris * 9);
    const palette = slotColors.map((c) => new THREE.Color(c));
    for (let t = 0; t < tris; t++) {
      const c = palette[mesh.extruders[t] % palette.length];
      for (let v = 0; v < 3; v++) col.set([c.r, c.g, c.b], t * 9 + v * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    this.modelMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide, flatShading: true,
    }));
    this.scene.add(this.modelMesh);
    const b = geo.boundingBox;
    this.#frame([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
    this.setMode('model');
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
    if (this.modelMesh) this.modelMesh.visible = mode === 'model';
    if (this.gcodeLines) this.gcodeLines.visible = mode === 'gcode';
  }
}
