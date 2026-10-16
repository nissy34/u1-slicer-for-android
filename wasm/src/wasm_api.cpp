// =============================================================================
// WASM spike — JS-facing API over the same sapil::SlicerEngine the Android app
// drives through JNI. Kotlin's SliceConfig marshalling (sapil_config.cpp) is
// replaced by a JSON object whose keys are the C++ SliceConfig field names.
//
// Files live in Emscripten's in-memory FS: the JS side writes the model to e.g.
// /work/model.stl, calls loadModel(), slice(), then reads result.gcodePath.
// =============================================================================
#include "sapil.h"

#include <emscripten/bind.h>
#include <nlohmann/json.hpp>

#include <memory>
#include <string>

using nlohmann::json;

namespace {

sapil::SlicerEngine& engine() {
    static std::unique_ptr<sapil::SlicerEngine> e = std::make_unique<sapil::SlicerEngine>();
    return *e;
}

template <typename T>
void get_if(const json& j, const char* key, T& out) {
    auto it = j.find(key);
    if (it != j.end() && !it->is_null()) out = it->get<T>();
}

sapil::SliceConfig config_from_json(const json& j) {
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

// --- exported -----------------------------------------------------------------

std::string coreVersion() { return engine().getCoreVersion(); }

bool loadModel(const std::string& path, int plateId) { return engine().loadModel(path, plateId); }

std::string modelInfoJson() {
    const sapil::ModelInfo i = engine().getModelInfo();
    return json{{"filename", i.filename}, {"format", i.format},
                {"sizeX", i.size_x}, {"sizeY", i.size_y}, {"sizeZ", i.size_z},
                {"triangleCount", i.triangle_count}, {"volumeCount", i.volume_count},
                {"isManifold", i.is_manifold}}
        .dump();
}

bool setModelInstances(const std::string& positionsJson) {
    std::vector<std::pair<float, float>> pos;
    for (const auto& p : json::parse(positionsJson)) pos.emplace_back(p.at(0).get<float>(), p.at(1).get<float>());
    return engine().setModelInstances(pos);
}

// Progress is forwarded to an optional JS callback(percent, stage).
std::string slice(const std::string& configJson, emscripten::val onProgress) {
    sapil::SliceResult r;
    try {
        const sapil::SliceConfig cfg = config_from_json(json::parse(configJson.empty() ? "{}" : configJson));
        sapil::ProgressCallback cb = nullptr;
        if (onProgress.typeOf().as<std::string>() == "function")
            cb = [onProgress](int pct, const std::string& stage) { onProgress(pct, stage); };
        r = engine().slice(cfg, cb);
    } catch (const std::exception& e) {
        r.success = false;
        r.error_message = std::string("wasm_api: ") + e.what();
    }
    return json{{"success", r.success}, {"cancelled", r.cancelled}, {"error", r.error_message},
                {"gcodePath", r.gcode_path}, {"totalLayers", r.total_layers},
                {"estimatedTimeSeconds", r.estimated_time_seconds},
                {"estimatedFilamentMm", r.estimated_filament_mm},
                {"estimatedFilamentGrams", r.estimated_filament_grams}}
        .dump();
}

void clearModel() { engine().clearModel(); }

} // namespace

EMSCRIPTEN_BINDINGS(u1slicer) {
    emscripten::function("coreVersion", &coreVersion);
    emscripten::function("loadModel", &loadModel);
    emscripten::function("modelInfoJson", &modelInfoJson);
    emscripten::function("setModelInstances", &setModelInstances);
    emscripten::function("slice", &slice);
    emscripten::function("clearModel", &clearModel);
}
