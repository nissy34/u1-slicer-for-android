// Shared by the wasm API and the native host CLI: build a sapil::SliceConfig
// from a JSON object whose keys are the C++ field names. Missing keys keep the
// C++ defaults.
#pragma once

#include "sapil.h"

#include <nlohmann/json.hpp>

namespace u1slicer {

using nlohmann::json;

template <typename T>
inline void get_if(const json& j, const char* key, T& out) {
    auto it = j.find(key);
    if (it != j.end() && !it->is_null()) out = it->get<T>();
}

inline sapil::SliceConfig config_from_json(const json& j) {
    sapil::SliceConfig c;
#define F(name) get_if(j, #name, c.name)
    F(layer_height); F(first_layer_height); F(perimeters); F(top_solid_layers);
    F(bottom_solid_layers); F(fill_density); F(fill_pattern);
    F(print_speed); F(travel_speed); F(first_layer_speed);
    F(nozzle_temp); F(bed_temp); F(retract_length); F(retract_speed);
    F(support_enabled); F(support_type); F(support_angle);
    F(support_filament); F(support_interface_filament);
    F(skirt_loops); F(skirt_distance); F(brim_width);
    F(bed_size_x); F(bed_size_y); F(max_print_height);
    F(nozzle_diameter); F(filament_diameter); F(filament_type); F(filament_types);
    F(extruder_count); F(extruder_temps); F(extruder_retract_length); F(extruder_retract_speed);
    F(wipe_tower_enabled); F(wipe_tower_x); F(wipe_tower_y); F(wipe_tower_width);
    F(machine_start_gcode); F(machine_end_gcode); F(machine_change_filament_gcode);
    F(machine_target); F(bambu_explicit_overrides);
    F(filament_flow_ratios); F(filament_max_volumetric_speeds);
    F(filament_fan_min_speeds); F(filament_fan_max_speeds);
    F(filament_overhang_fan_speeds); F(filament_additional_cooling_fan_speeds);
    F(filament_slow_down_layer_times); F(filament_slow_down_min_speeds);
    F(filament_close_fan_first_layers); F(filament_full_fan_speed_layers);
    F(filament_enable_pressure_advance); F(filament_pressure_advances);
    F(filament_minimal_purge_on_wipe_tower); F(filament_nozzle_temp_initial_layers);
    F(filament_bed_temp_initial_layers); F(filament_costs);
    F(mixed_filament_definitions);
#undef F
    return c;
}

} // namespace u1slicer
