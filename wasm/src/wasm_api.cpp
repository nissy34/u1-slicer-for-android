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
#include <emscripten/threading.h>
#include "slice_config_json.hpp"

#include <memory>
#include <string>

using nlohmann::json;
using u1slicer::config_from_json;

namespace {

sapil::SlicerEngine& engine() {
    static std::unique_ptr<sapil::SlicerEngine> e = std::make_unique<sapil::SlicerEngine>();
    return *e;
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

// Progress is forwarded to an optional JS callback(percent, stage). Orca reports
// some stages from TBB worker threads (GCode::process_layers runs a
// tbb::parallel_pipeline, which the Android serial shim does not cover), and an
// emscripten::val may only be touched on the thread that created it — so
// off-main-thread updates are dropped. The next main-thread update supersedes
// them anyway.
std::string slice(const std::string& configJson, emscripten::val onProgress) {
    sapil::SliceResult r;
    try {
        const sapil::SliceConfig cfg = config_from_json(json::parse(configJson.empty() ? "{}" : configJson));
        sapil::ProgressCallback cb = nullptr;
        if (onProgress.typeOf().as<std::string>() == "function")
            cb = [onProgress](int pct, const std::string& stage) {
                if (emscripten_is_main_runtime_thread()) onProgress(pct, stage);
            };
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

// Prepare-preview mesh of the loaded model (the same native mesh the app's
// Prepare screen renders): { positions: Float32Array (9 floats / triangle,
// bed space mm), extruders: Uint8Array (0-based slot per triangle) }.
// maxTriangles 0 = engine's own budget.
emscripten::val previewMesh(int maxTriangles) {
    const sapil::PreviewMesh m = engine().getPreparePreviewMesh(maxTriangles);
    emscripten::val out = emscripten::val::object();
    // typed_memory_view aliases wasm memory; slice() copies it out before m dies.
    out.set("positions", emscripten::val(emscripten::typed_memory_view(m.triangle_positions.size(),
                                                                    m.triangle_positions.data()))
                             .call<emscripten::val>("slice"));
    out.set("extruders", emscripten::val(emscripten::typed_memory_view(m.extruder_indices.size(),
                                                                    m.extruder_indices.data()))
                             .call<emscripten::val>("slice"));
    return out;
}

void clearModel() { engine().clearModel(); }

// Current size of the wasm heap in bytes. Linear memory only ever grows, so
// after a slice this is that slice's peak — the number to watch against the
// 4 GB wasm32 ceiling.
double heapBytes() { return double(__builtin_wasm_memory_size(0)) * 65536.0; }

} // namespace

EMSCRIPTEN_BINDINGS(u1slicer) {
    emscripten::function("coreVersion", &coreVersion);
    emscripten::function("loadModel", &loadModel);
    emscripten::function("modelInfoJson", &modelInfoJson);
    emscripten::function("setModelInstances", &setModelInstances);
    emscripten::function("slice", &slice);
    emscripten::function("clearModel", &clearModel);
    emscripten::function("heapBytes", &heapBytes);
    emscripten::function("previewMesh", &previewMesh);
}
