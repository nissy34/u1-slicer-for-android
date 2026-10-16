// Stub implementations for OrcaSlicer features excluded from Android build
// These are referenced by libslic3r but not needed for headless FFF slicing.

// Use our Android STEP.hpp stub (provides Step class without OCCT dependency).
// Include path has extern/libslic3r_android first, so "Format/STEP.hpp" picks
// up our stub before the real OCCT-dependent header.
#ifndef SAPIL_WITH_STEP
#include "Format/STEP.hpp"
#endif
#include "libslic3r/Polygon.hpp"
#include <string>
#include <vector>
#include <functional>

namespace Slic3r {
class Model;
class PerimeterGenerator;
namespace Arachne { struct ExtrusionLine; }

#ifndef SAPIL_WITH_STEP
// STEP — excluded (needs OCCT). Implement Step class methods declared in stub header.
Step::Step(std::string, ImportStepProgressFn, StepIsUtf8Fn) {}
bool Step::load() { return false; }

bool load_step(const char*, Model*, bool&,
               double, double, bool,
               ImportStepProgressFn, StepIsUtf8Fn,
               long&) {
    return false;
}
#endif // SAPIL_WITH_STEP — real Format/STEP.cpp is compiled instead

// FuzzySkin — excluded (needs libnoise)
namespace Feature { namespace FuzzySkin {
void apply_fuzzy_skin(Arachne::ExtrusionLine*, const PerimeterGenerator&, bool) {}
// Must match Feature/FuzzySkin/FuzzySkin.hpp exactly, including the Polygon
// return: a void stub left callers reading an unwritten return slot (undefined
// behaviour on ARM64; a signature-mismatch trap on wasm). No fuzz = identity.
Polygon apply_fuzzy_skin(const Polygon& polygon, const PerimeterGenerator&, size_t, bool) { return polygon; }
void group_region_by_fuzzify(PerimeterGenerator&) {}
} } // namespace Feature::FuzzySkin

// SVG loading — excluded (needs OCCT 7.6)
bool load_svg(const char*, Model*, std::string&) {
    return false;
}

namespace png {
// PNG writing — excluded (needs real libpng)
bool write_rgb_to_file_scaled(const std::string&, size_t, size_t,
                               const std::vector<unsigned char>&, size_t) {
    return false;
}
} // namespace png
} // namespace Slic3r
