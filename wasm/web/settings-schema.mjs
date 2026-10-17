// The Prepare-screen settings, row for row from the app's SlicingOverridesAccordion
// (app/src/main/java/com/u1/slicer/ui/SlicingOverridesUI.kt): each row is a
// SlicingOverrides field with a File / Orca / Override mode, the Orca default
// hint, and the 3MF's own value (project_settings.config key) shown as "File: …".
//
// type: 'float' | 'int' | 'bool' | 'enum'. `percent` rows show value × 100.
// `when(ov)` hides sub-rows like the app does (support sub-settings only when
// supports are relevant; tree branch rows only for tree support types).
const SURFACE = [['monotonic', 'Monotonic'], ['monotonicaline', 'Monotonic Line'], ['alignedrectilinear', 'Aligned Rectilinear'],
  ['concentric', 'Concentric'], ['hilbertcurve', 'Hilbert Curve'], ['archimedeanChords', 'Archimedean Chords'],
  ['octagramspiral', 'Octagram Spiral']];

// Support sub-settings show only once Supports is overridden on (as in the app).
const supportsOn = (ov) => ov.supports.mode === 'OVERRIDE' && ov.supports.value === true;
const treeType = (ov) => supportsOn(ov) && String(ov.supportType.value ?? '').startsWith('tree');

export const SETTINGS_SECTIONS = [
  {
    key: 'layer', title: 'Layer & infill', rows: [
      { field: 'layerHeight', label: 'Layer height', type: 'float', hint: '0.2 mm', fileKey: 'layer_height', unit: 'mm', min: 0.04, max: 0.4, step: 0.02 },
      { field: 'infillDensity', label: 'Infill density', type: 'float', percent: true, hint: '15%', fileKey: 'sparse_infill_density', unit: '%', min: 0, max: 100, step: 1 },
      { field: 'wallCount', label: 'Wall count', type: 'int', hint: '2', fileKey: 'wall_loops', min: 1, max: 20 },
      { field: 'wallGenerator', label: 'Wall generator', type: 'enum', hint: 'Arachne', fileKey: 'wall_generator', options: [['classic', 'Classic'], ['arachne', 'Arachne']] },
      { field: 'seamPosition', label: 'Seam position', type: 'enum', hint: 'Aligned', fileKey: 'seam_position',
        options: [['nearest', 'Nearest'], ['aligned', 'Aligned'], ['aligned_back', 'Aligned Back'], ['back', 'Back'], ['random', 'Random']] },
      { field: 'infillPattern', label: 'Infill pattern', type: 'enum', hint: 'gyroid', fileKey: 'sparse_infill_pattern',
        options: ['gyroid', 'grid', 'lines', 'honeycomb', 'cubic', 'triangles', 'rectilinear', 'adaptive_cubic', 'lightning'].map((p) => [p, p]) },
      { field: 'sparseInfillSpeed', label: 'Infill speed', type: 'int', hint: 'auto', fileKey: 'sparse_infill_speed', unit: 'mm/s', min: 0, max: 1000 },
      { field: 'topShellLayers', label: 'Top shell layers', type: 'int', hint: '5', fileKey: 'top_shell_layers', min: 0, max: 50 },
      { field: 'bottomShellLayers', label: 'Bottom shell layers', type: 'int', hint: '4', fileKey: 'bottom_shell_layers', min: 0, max: 50 },
      { field: 'topSurfacePattern', label: 'Top surface pattern', type: 'enum', hint: 'Monotonic', fileKey: 'top_surface_pattern', options: SURFACE },
      { field: 'bottomSurfacePattern', label: 'Bottom surface pattern', type: 'enum', hint: 'Monotonic', fileKey: 'bottom_surface_pattern', options: SURFACE },
      { field: 'reduceInfillRetraction', label: 'Reduce infill retraction', type: 'bool', hint: 'Off', fileKey: 'reduce_infill_retraction' },
    ],
  },
  {
    key: 'support', title: 'Support', rows: [
      { field: 'supports', label: 'Supports', type: 'bool', hint: 'Off', fileKey: 'enable_support' },
      { field: 'supportType', label: 'Support type', sub: true, when: supportsOn, type: 'enum', hint: 'Normal (Auto)', fileKey: 'support_type', options: [['normal(auto)', 'Normal'], ['tree(auto)', 'Tree']] },
      { field: 'supportAngle', label: 'Threshold angle', sub: true, when: supportsOn, type: 'int', hint: '30°', fileKey: 'support_threshold_angle', unit: '°', min: 0, max: 90 },
      { field: 'supportBuildPlateOnly', label: 'Build plate only', sub: true, when: supportsOn, type: 'bool', hint: 'Off', fileKey: 'support_on_build_plate_only' },
      { field: 'supportPattern', label: 'Support pattern', sub: true, when: supportsOn, type: 'enum', hint: 'Default', fileKey: 'support_base_pattern',
        options: ['default', 'rectilinear', 'rectilinear_grid', 'honeycomb', 'lightning'].map((p) => [p, p]) },
      { field: 'supportPatternSpacing', label: 'Pattern spacing', sub: true, when: supportsOn, type: 'float', hint: '2.5 mm', fileKey: 'support_base_pattern_spacing', unit: 'mm', min: 0, max: 20, step: 0.1 },
      { field: 'supportInterfaceTopLayers', label: 'Interface top layers', sub: true, when: supportsOn, type: 'int', hint: '3', fileKey: 'support_interface_top_layers', min: 0, max: 20 },
      { field: 'supportInterfaceBottomLayers', label: 'Interface bottom layers', sub: true, when: supportsOn, type: 'int', hint: '0', fileKey: 'support_interface_bottom_layers', min: 0, max: 20 },
      { field: 'supportFilament', label: 'Support filament', sub: true, when: supportsOn, type: 'enum', hint: 'Default', fileKey: 'support_filament', options: 'filaments' },
      { field: 'supportInterfaceFilament', label: 'Interface filament', sub: true, when: supportsOn, type: 'enum', hint: 'Default', fileKey: 'support_interface_filament', options: 'filaments' },
      { field: 'supportXyDistance', label: 'XY distance', sub: true, when: supportsOn, type: 'float', hint: '0.35 mm', fileKey: 'support_object_xy_distance', unit: 'mm', min: 0, max: 5, step: 0.05 },
      { field: 'supportInterfacePattern', label: 'Interface pattern', sub: true, when: supportsOn, type: 'enum', hint: 'Auto', fileKey: 'support_interface_pattern',
        options: [['auto', 'Auto'], ['rectilinear', 'Rectilinear'], ['concentric', 'Concentric'], ['rectilinear_grid', 'Rectilinear Grid']] },
      { field: 'supportInterfaceSpacing', label: 'Interface spacing', sub: true, when: supportsOn, type: 'float', hint: '0.5 mm', fileKey: 'support_interface_spacing', unit: 'mm', min: 0, max: 10, step: 0.1 },
      { field: 'supportSpeed', label: 'Support speed', sub: true, when: supportsOn, type: 'int', hint: 'auto', fileKey: 'support_speed', unit: 'mm/s', min: 0, max: 1000 },
      { field: 'treeSupportBranchAngle', label: 'Branch angle', sub: true, when: treeType, type: 'int', hint: '40°', fileKey: 'tree_support_branch_angle', unit: '°', min: 0, max: 90 },
      { field: 'treeSupportBranchDistance', label: 'Branch distance', sub: true, when: treeType, type: 'float', hint: '5.0 mm', fileKey: 'tree_support_branch_distance', unit: 'mm', min: 0, max: 50, step: 0.5 },
      { field: 'treeSupportBranchDiameter', label: 'Branch diameter', sub: true, when: treeType, type: 'float', hint: '5.0 mm', fileKey: 'tree_support_branch_diameter', unit: 'mm', min: 0, max: 50, step: 0.5 },
    ],
  },
  {
    key: 'tower', title: 'Prime tower', rows: [
      { field: 'primeTower', label: 'Prime tower', type: 'bool', hint: 'Off', fileKey: 'enable_prime_tower' },
      { field: 'primeVolume', label: 'Prime volume', type: 'int', hint: '45', fileKey: 'prime_volume', unit: 'mm³', min: 0, max: 500 },
      { field: 'primeTowerBrimWidth', label: 'Tower brim width', type: 'float', hint: '3 mm', fileKey: 'prime_tower_brim_width', unit: 'mm', min: 0, max: 20, step: 0.5 },
      { field: 'primeTowerBrimChamfer', label: 'Brim chamfer', type: 'bool', hint: 'On', fileKey: 'prime_tower_brim_chamfer' },
      { field: 'primeTowerChamferMaxWidth', label: 'Chamfer max width', type: 'float', hint: '5 mm', fileKey: 'prime_tower_brim_chamfer_max_width', unit: 'mm', min: 0, max: 20, step: 0.5 },
      { field: 'primeTowerWidth', label: 'Tower width', type: 'float', hint: '35 mm', fileKey: 'prime_tower_width', unit: 'mm', min: 10, max: 120, step: 1 },
      { field: 'wipeTowerRotationAngle', label: 'Tower rotation', type: 'float', hint: '0°', fileKey: 'wipe_tower_rotation_angle', unit: '°', min: -180, max: 180, step: 1 },
    ],
  },
  {
    key: 'temperature', title: 'Temperature', rows: [
      { field: 'bedTemp', label: 'Bed temp', type: 'int', hint: '60°C', fileKey: 'hot_plate_temp', unit: '°C', min: 0, max: 120 },
    ],
  },
  {
    key: 'other', title: 'Other', rows: [
      { field: 'brimWidth', label: 'Brim width', type: 'float', hint: '0 mm', fileKey: 'brim_width', unit: 'mm', min: 0, max: 30, step: 1 },
      { field: 'skirtLoops', label: 'Skirt loops', type: 'int', hint: '0', fileKey: 'skirt_loops', min: 0, max: 10 },
    ],
  },
];

/** The value a row edits in its OVERRIDE input (Kotlin default when the override has none). */
export function rowInputValue(row, ov, orcaDefaults) {
  const v = ov[row.field]?.value ?? orcaDefaults[row.field];
  if (row.percent) return Math.round(Number(v) * 100);
  return v;
}

/** Parses an input back to the override value (percent rows ÷ 100; locale commas accepted, B139). */
export function parseRowInput(row, raw) {
  if (row.type === 'bool') return !!raw;
  if (row.type === 'enum') return row.options === 'filaments' ? Number(raw) : raw;
  const n = Number(String(raw).trim().replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const v = row.type === 'int' ? Math.trunc(n) : n;
  return row.percent ? v / 100 : v;
}

/**
 * buildSupportFilamentOptions (SlicingOverridesUI.kt): one option per physical
 * slot, labelled by slot, whose config value is the 1-based FILE filament mapped
 * onto that slot (support_filament indexes filament_colour), or a synthetic
 * index past the file's filaments for an unmapped slot.
 */
export function buildSupportFilamentOptions({ extruderPresets, colorMapping, filamentCount, slotCount = 4 }) {
  const used = new Set();
  return Array.from({ length: slotCount }, (_, slot) => {
    const mapped = colorMapping ? colorMapping.indexOf(slot) : -1;
    const preferred = mapped >= 0 ? mapped + 1 : colorMapping == null ? slot + 1 : null;
    let configValue;
    if (preferred != null && !used.has(preferred)) configValue = preferred;
    else {
      configValue = Math.max(slot + 1, (filamentCount ?? 0) + 1);
      while (used.has(configValue)) configValue++;
    }
    used.add(configValue);
    const preset = extruderPresets.find((p) => p.index === slot);
    const material = preset?.materialType?.trim() ? preset.materialType : 'PLA';
    const color = preset?.color?.trim() ? preset.color.toUpperCase() : null;
    return { configValue, label: `E${slot + 1} · ${material}${color ? ` · ${color}` : ''}` };
  });
}
