// =============================================================================
// Native host reference build of the same engine the wasm module runs
// (built from wasm/CMakeLists.txt without Emscripten). Used to tell wasm32
// porting bugs apart from engine behaviour, and as the G-code reference the
// wasm output is diffed against.
//
//   u1slicer-host <model> <out.gcode> [config.json] [--plate N]
// =============================================================================
#include "sapil.h"
#include "slice_config_json.hpp"

#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include <unistd.h>

namespace fs = std::filesystem;
using nlohmann::json;

static std::string read_text(const fs::path& p) {
    std::ifstream f(p, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

int main(int argc, char** argv) {
    std::vector<std::string> args(argv + 1, argv + argc);
    int plate = 0;
    for (size_t i = 0; i + 1 < args.size(); ++i)
        if (args[i] == "--plate") {
            plate = std::stoi(args[i + 1]);
            args.erase(args.begin() + i, args.begin() + i + 2);
            break;
        }
    if (args.size() < 2) {
        std::fprintf(stderr, "usage: u1slicer-host <model> <out.gcode> [config.json] [--plate N]\n");
        return 2;
    }

    json cfg = json::object();
    if (args.size() >= 3) {
        cfg = json::parse(read_text(args[2]));
        // Same *_file convenience keys as wasm/node/slice.mjs.
        for (const char* key : {"machine_start_gcode", "machine_end_gcode", "machine_change_filament_gcode"}) {
            const std::string fk = std::string(key) + "_file";
            if (cfg.contains(fk)) {
                cfg[key] = read_text(fs::path(args[2]).parent_path() / cfg[fk].get<std::string>());
                cfg.erase(fk);
            }
        }
    }

    // Mirror the wasm driver: the engine writes output.gcode next to the model,
    // so stage the model in a scratch dir.
    const fs::path work = fs::temp_directory_path() / ("u1slicer-host-" + std::to_string(::getpid()));
    fs::create_directories(work);
    const fs::path model = work / fs::path(args[0]).filename();
    fs::copy_file(args[0], model, fs::copy_options::overwrite_existing);

    using clk = std::chrono::steady_clock;
    sapil::SlicerEngine engine;
    std::fprintf(stderr, "core: %s\n", engine.getCoreVersion().c_str());
    const auto t0 = clk::now();
    if (!engine.loadModel(model.string(), plate)) {
        std::fprintf(stderr, "loadModel failed\n");
        return 1;
    }
    const auto t1 = clk::now();
    const sapil::SliceResult r = engine.slice(u1slicer::config_from_json(cfg));
    const auto t2 = clk::now();
    const auto ms = [](auto d) { return (long long) std::chrono::duration_cast<std::chrono::milliseconds>(d).count(); };
    std::fprintf(stderr, "result: success=%d layers=%d time=%.0fs filament=%.1fmm err=%s\n", r.success,
                 r.total_layers, r.estimated_time_seconds, r.estimated_filament_mm, r.error_message.c_str());
    std::fprintf(stderr, "timing: load %lldms, slice %lldms\n", ms(t1 - t0), ms(t2 - t1));
    if (!r.success) return 1;
    fs::copy_file(r.gcode_path, args[1], fs::copy_options::overwrite_existing);
    fs::remove_all(work);
    return 0;
}
