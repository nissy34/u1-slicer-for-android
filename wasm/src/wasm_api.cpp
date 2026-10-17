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

#include "libslic3r/Format/bbs_3mf.hpp"
#include "libslic3r/Model.hpp"
#include "sapil_bambu_snapshot.h"
#include "libslic3r/PrintConfig.hpp"

#include <memory>
#include <sstream>
#include <string>

using nlohmann::json;
using u1slicer::config_from_json;

namespace sapil {
// sapil_model.cpp: the config embedded in the loaded 3MF (project_settings.config).
Slic3r::DynamicPrintConfig& getModelConfig();
// sapil_model.cpp: the loaded model, and the per-volume triangle counts of the
// last Prepare-preview build (standalone accessors of the app's fix36/F95 JNI ones).
extern Slic3r::Model g_model;
extern Slic3r::PlateDataPtrs g_plate_data_list;
std::vector<int> previewVolumeTriangleCounts();
int previewModifierBlockStart();
}

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

// Triangles each object contributes to the cached preview mesh, indexed by
// object. The engine emits objects -> printable instances -> model-part volumes
// in order and records one count per volume; this walks g_model with the same
// skip rules to attribute the counts to objects.
std::vector<int> previewObjectTriangleCounts() {
    const std::vector<int> perVolume = sapil::previewVolumeTriangleCounts();
    const auto& objects = sapil::g_model.objects;
    std::vector<int> perObject(objects.size(), 0);
    size_t k = 0;
    for (size_t o = 0; o < objects.size(); ++o) {
        const auto* object = objects[o];
        if (object == nullptr || !object->printable || object->instances.empty()) continue;
        for (const auto* instance : object->instances) {
            if (instance == nullptr || !instance->printable) continue;
            for (const auto* volume : object->volumes) {
                if (volume == nullptr || !volume->is_model_part()) continue;
                if (k < perVolume.size()) perObject[o] += perVolume[k];
                ++k;
            }
        }
    }
    return perObject;
}

template <typename T>
emscripten::val typedCopy(const std::vector<T>& v) {
    // typed_memory_view aliases wasm memory; slice() copies it out before v dies.
    return emscripten::val(emscripten::typed_memory_view(v.size(), v.data())).template call<emscripten::val>("slice");
}

// Prepare-preview mesh of the loaded model (the same native mesh the app's
// Prepare screen renders): { positions: Float32Array (9 floats / triangle,
// bed space mm), extruders: Uint8Array (0-based slot per triangle),
// objectTriangles: Int32Array (triangles per object, in mesh order; the
// trailing negative-volume block is not included), modifierStart (first
// triangle of that block, -1 if none) }. maxTriangles 0 = engine's own budget.
emscripten::val previewMesh(int maxTriangles) {
    const sapil::PreviewMesh m = engine().getPreparePreviewMesh(maxTriangles);
    emscripten::val out = emscripten::val::object();
    out.set("objectTriangles", typedCopy(previewObjectTriangleCounts()));
    out.set("modifierStart", sapil::previewModifierBlockStart());
    // typed_memory_view aliases wasm memory; slice() copies it out before m dies.
    out.set("positions", typedCopy(m.triangle_positions));
    out.set("extruders", typedCopy(m.extruder_indices));
    return out;
}

// A key from the loaded 3MF's embedded project config, serialised the way
// Orca writes it (e.g. filament_colour -> "#FF0000;#00FF00"); "" if absent.
std::string projectConfigValue(const std::string& key) {
    const Slic3r::ConfigOption* opt = sapil::getModelConfig().option(key);
    return opt ? opt->serialize() : std::string();
}

void clearModel() { engine().clearModel(); }

// ---- Prepare-screen editing (the app's F66/F77/F92 object operations) ---------

bool addModel(const std::string& path, int plateId) { return engine().addModel(path, plateId); }
int objectCount() { return static_cast<int>(sapil::g_model.objects.size()); }

std::vector<std::pair<float, float>> parsePairs(const std::string& jsonText) {
    std::vector<std::pair<float, float>> pos;
    const json j = json::parse(jsonText);
    // Accept [[x, y], ...] or a flat [x0, y0, x1, y1, ...] like the JNI float arrays.
    if (!j.empty() && j.at(0).is_array()) {
        for (const auto& p : j) pos.emplace_back(p.at(0).get<float>(), p.at(1).get<float>());
    } else {
        for (size_t i = 0; i + 1 < j.size(); i += 2) pos.emplace_back(j[i].get<float>(), j[i + 1].get<float>());
    }
    return pos;
}

bool setModelInstances(const std::string& positionsJson) { return engine().setModelInstances(parsePairs(positionsJson)); }
bool setObjectPositions(const std::string& positionsJson) { return engine().setObjectPositions(parsePairs(positionsJson)); }
bool setModelScale(float x, float y, float z) { return engine().setModelScale(x, y, z); }
bool setModelRotation(float x, float y, float z) { return engine().setModelRotation(x, y, z); }
bool setObjectRotation(int i, float x, float y, float z) { return engine().setObjectRotation(i, x, y, z); }
bool setObjectScale(int i, float x, float y, float z) { return engine().setObjectScale(i, x, y, z); }
bool setVolumeExtruder(int o, int v, int slot) { return engine().setVolumeExtruder(o, v, slot); }
int duplicateObject(int i) { return engine().duplicateObject(i).value_or(-1); }
bool splitObject(int i) { return engine().splitObject(i).has_value(); }
int autoOrientAll() { return engine().autoOrientAll(); }
// New Euler rotation in degrees as JSON [x, y, z], or "" on failure.
std::string autoOrientObject(int i) {
    const auto r = engine().autoOrientObject(i);
    if (!r) return "";
    constexpr double toDeg = 180.0 / 3.14159265358979323846;
    return json{(*r)[0] * toDeg, (*r)[1] * toDeg, (*r)[2] * toDeg}.dump();
}
// The app's nativeGetPlateCount / nativeGetPlateData (sapil_bambu_plate.cpp):
// per-plate data of the loaded 3MF as JSON, used by the layer-tool pause injector.
int plateCount() { return sapil::g_model.objects.empty() ? 0 : static_cast<int>(sapil::g_plate_data_list.size()); }
std::string plateDataJson(int plateIndex) {
    if (plateIndex < 0 || sapil::g_model.objects.empty()) return "";
    const auto& plates = sapil::g_plate_data_list;
    if (static_cast<size_t>(plateIndex) >= plates.size() || plates[plateIndex] == nullptr) return "";
    const auto& cfg = sapil::getModelConfig();
    std::ostringstream out;
    sapil::append_plate(out, *plates[plateIndex], cfg.opt<Slic3r::ConfigOptionStrings>("filament_colour"),
                        cfg.opt<Slic3r::ConfigOptionStrings>("filament_ids"),
                        cfg.opt<Slic3r::ConfigOptionStrings>("filament_settings_id"));
    return out.str();
}

// The app's nativeGetAllVolumeExtruders (sapil_bambu_volume_map.cpp): per-object,
// per-volume extruder + paint flags, the input of NativePlateState.parseVolumeMapJson.
std::string allVolumeExtrudersJson() {
    if (sapil::g_model.objects.empty()) return "";
    std::ostringstream out;
    out << "[";
    for (size_t i = 0; i < sapil::g_model.objects.size(); ++i) {
        if (i) out << ",";
        const auto* mo = sapil::g_model.objects[i];
        if (!mo) { out << "null"; continue; }
        const int obj_ext = mo->config.has("extruder") ? mo->config.opt_int("extruder") : 0;
        out << "{\"objectIndex\":" << i << ",\"objectExtruder\":" << obj_ext << ",\"volumes\":[";
        for (size_t j = 0; j < mo->volumes.size(); ++j) {
            if (j) out << ",";
            const auto* mv = mo->volumes[j];
            if (!mv) { out << "null"; continue; }
            const int vol_ext = mv->config.has("extruder") ? mv->config.opt_int("extruder") : -1;
            out << "{\"volumeIndex\":" << j << ",\"extruder\":" << vol_ext
                << ",\"isMmPainted\":" << (mv->is_mm_painted() ? "true" : "false")
                << ",\"isSeamPainted\":" << (mv->is_seam_painted() ? "true" : "false") << "}";
        }
        out << "]}";
    }
    out << "]";
    return out.str();
}

// The app's nativeGetPaintStateCounts (sapil_bambu_volumes.cpp): flat
// [state0, count0, state1, count1, ...] for kind 0 (colour) / 1 (supports), or "" on bad input.
std::string paintStateCountsJson(int objectIndex, int volumeIndex, int kind) {
    if (objectIndex < 0 || volumeIndex < 0 || (kind != 0 && kind != 1)) return "";
    const auto& objs = sapil::g_model.objects;
    if (static_cast<size_t>(objectIndex) >= objs.size() || objs[objectIndex] == nullptr) return "";
    const auto* mo = objs[objectIndex];
    if (static_cast<size_t>(volumeIndex) >= mo->volumes.size() || mo->volumes[volumeIndex] == nullptr) return "";
    const auto* mv = mo->volumes[volumeIndex];
    const auto counts = sapil::count_paint_states(*mv, kind == 0 ? mv->mmu_segmentation_facets : mv->supported_facets);
    json packed = json::array();
    for (const auto& kv : counts) { packed.push_back(kv.first); packed.push_back(kv.second); }
    return packed.dump();
}

std::string instanceOffsetsJson() { return json(engine().getInstanceOffsets()).dump(); }
std::string instanceWorldZMinsJson() { return json(engine().getInstanceWorldZMins()).dump(); }

// One entry per object: name, footprint size (instance[0] scale + rotation),
// world AABB min (what setObjectPositions takes), rotation (deg), scale, and
// volumes with their 1-based extruder.
std::string objectsJson() {
    sapil::SlicerEngine& e = engine();
    const std::vector<float> sizes = e.getObjectBoundingBoxes();
    const std::vector<float> mins = e.getObjectWorldAABBMins();
    json out = json::array();
    const int n = objectCount();
    for (int i = 0; i < n; ++i) {
        json vols = json::array();
        const auto* obj = sapil::g_model.objects[i];
        for (int v = 0; v < static_cast<int>(obj->volumes.size()); ++v) {
            const auto* vol = obj->volumes[v];
            vols.push_back({{"name", e.getVolumeName(i, v)}, {"extruder", e.getVolumeExtruder(i, v)},
                            {"modelPart", vol->is_model_part()}, {"negative", vol->is_negative_volume()}});
        }
        const auto rot = e.getObjectRotation(i);
        const auto scl = e.getObjectScale(i);
        out.push_back({
            {"name", e.getObjectName(i)},
            {"size", size_t(i) * 3 + 2 < sizes.size() ? json{sizes[i * 3], sizes[i * 3 + 1], sizes[i * 3 + 2]} : json(nullptr)},
            {"min", size_t(i) * 2 + 1 < mins.size() ? json{mins[i * 2], mins[i * 2 + 1]} : json(nullptr)},
            {"rotation", {rot[0], rot[1], rot[2]}},
            {"scale", {scl[0], scl[1], scl[2]}},
            {"instances", obj->instances.size()},
            {"splittable", e.isObjectSplittable(i)},
            {"volumes", vols},
        });
    }
    return out.dump();
}

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
    emscripten::function("projectConfigValue", &projectConfigValue);
    emscripten::function("addModel", &addModel);
    emscripten::function("objectCount", &objectCount);
    emscripten::function("objectsJson", &objectsJson);
    emscripten::function("setObjectPositions", &setObjectPositions);
    emscripten::function("setModelScale", &setModelScale);
    emscripten::function("setModelRotation", &setModelRotation);
    emscripten::function("setObjectRotation", &setObjectRotation);
    emscripten::function("setObjectScale", &setObjectScale);
    emscripten::function("setVolumeExtruder", &setVolumeExtruder);
    emscripten::function("duplicateObject", &duplicateObject);
    emscripten::function("splitObject", &splitObject);
    emscripten::function("autoOrientObject", &autoOrientObject);
    emscripten::function("autoOrientAll", &autoOrientAll);
    emscripten::function("instanceOffsetsJson", &instanceOffsetsJson);
    emscripten::function("instanceWorldZMinsJson", &instanceWorldZMinsJson);
    emscripten::function("plateCount", &plateCount);
    emscripten::function("plateDataJson", &plateDataJson);
    emscripten::function("allVolumeExtrudersJson", &allVolumeExtrudersJson);
    emscripten::function("paintStateCountsJson", &paintStateCountsJson);
}
