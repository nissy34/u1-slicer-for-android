// The slice config the Android app sends to the engine for a plain model file
// (STL/OBJ/raw 3MF with no embedded Snapmaker profile), so wasm output matches
// what the app would produce. Sources, keep in sync:
//   - speeds:        app/src/main/java/com/u1/slicer/data/SliceConfig.kt defaults
//   - nozzle temps:  nozzleTempDefaultForMaterial() in SlicerViewModel.kt
//   - bed temps:     PlateType.bedTempFor() in data/PlateType.kt (default plate: Textured PEI)
//   - start/end:     B106 readPrinterMachineGcode() -> assets/orca_profiles/printer/snapmaker_u1.json
//   - layer height:  the app sends 0 ("profile decides") unless the user overrides it
//
// Keys are sapil::SliceConfig field names (see wasm/src/slice_config_json.hpp).

export const MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PVA'];

export const PLATES = {
  TEXTURED_PEI: 'Textured PEI',
  SMOOTH_PEI: 'Smooth PEI',
  COOL_PLATE: 'Cool Plate',
  ENGINEERING_PLATE: 'Engineering Plate',
};

export function nozzleTempFor(material) {
  return { PETG: 235, ABS: 270, ASA: 260, PA: 260, TPU: 225, PVA: 210 }[material.toUpperCase()] ?? 220;
}

export function bedTempFor(plate, material) {
  const m = material.toUpperCase();
  const is = (...p) => p.some((x) => m.startsWith(x));
  switch (plate) {
    case 'SMOOTH_PEI':
      return is('ABS', 'ASA') ? 100 : is('PETG', 'PC') ? 70 : is('TPU') ? 40 : 55;
    case 'COOL_PLATE':
      return is('PETG', 'ABS', 'ASA', 'PC') ? 65 : 35;
    case 'ENGINEERING_PLATE':
      return is('ABS', 'ASA') ? 110 : is('PC') ? 120 : is('PETG') ? 75 : is('TPU') ? 40 : 45;
    default: // TEXTURED_PEI
      return is('ABS', 'ASA') ? 100 : is('PETG', 'PC') ? 70 : is('TPU') ? 40 : 65;
  }
}

/**
 * @param printerProfile parsed assets/orca_profiles/printer/snapmaker_u1.json
 * @param material       filament material for every slot
 * @param plate          a PLATES key
 */
export function appSliceDefaults(printerProfile, { material = 'PLA', plate = 'TEXTURED_PEI' } = {}) {
  return {
    layer_height: 0, // sentinel: native profile default (0.20 mm)
    first_layer_height: 0.3,
    perimeters: 2,
    top_solid_layers: 5,
    bottom_solid_layers: 4,
    fill_density: 0.15,
    fill_pattern: 'gyroid',
    print_speed: 200,
    travel_speed: 500,
    first_layer_speed: 50,
    nozzle_temp: nozzleTempFor(material),
    bed_temp: bedTempFor(plate, material),
    retract_length: 0.8,
    retract_speed: 45,
    support_enabled: false,
    support_type: 'normal',
    support_angle: 45,
    skirt_loops: 0,
    skirt_distance: 6,
    brim_width: 0,
    bed_size_x: 270,
    bed_size_y: 270,
    max_print_height: 270,
    nozzle_diameter: 0.4,
    filament_diameter: 1.75,
    filament_type: material,
    extruder_count: 1,
    wipe_tower_enabled: false,
    wipe_tower_x: 170,
    wipe_tower_y: 140,
    wipe_tower_width: 60,
    machine_start_gcode: printerProfile?.machine_start_gcode ?? '',
    machine_end_gcode: printerProfile?.machine_end_gcode ?? '',
    machine_target: 'SNAPMAKER_U1',
  };
}
