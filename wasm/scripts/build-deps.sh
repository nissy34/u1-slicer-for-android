#!/usr/bin/env bash
# =============================================================================
# WASM spike: cross-compile the slicer's third-party deps with Emscripten.
#
# Output layout mirrors the Android `extern/` bundle so the shared
# app/src/main/cpp/CMakeLists.txt can consume it unchanged:
#     $OUT/<dep>/include
#     $OUT/<dep>/lib/wasm32/*.a
#
# Usage:
#     source /path/to/emsdk/emsdk_env.sh
#     wasm/scripts/build-deps.sh [dep ...]     # default: all
#
# Env:
#     WASM_DEPS_OUT   output root   (default: wasm/build/deps)
#     WASM_DEPS_WORK  scratch root  (default: wasm/build/deps-src)
#
# Every library is built with the SAME codegen flags as the engine
# (-pthread -fwasm-exceptions). Mixing exception models or pthread / no-pthread
# objects in one wasm link fails or misbehaves, so do not change one without
# the other (see WASM_COMMON_FLAGS in wasm/CMakeLists.txt).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${WASM_DEPS_OUT:-$WASM_DIR/build/deps}"
WORK="${WASM_DEPS_WORK:-$WASM_DIR/build/deps-src}"
ABI=wasm32
JOBS="${JOBS:-$(nproc)}"

FLAGS="-O2 -pthread -fwasm-exceptions"
export CFLAGS="$FLAGS"
export CXXFLAGS="$FLAGS"
export LDFLAGS="-pthread -fwasm-exceptions"

command -v emcc >/dev/null || { echo "emcc not on PATH — source emsdk_env.sh first"; exit 1; }
mkdir -p "$OUT" "$WORK"

fetch_git() { # url tag dir
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=advice.detachedHead GIT_CONFIG_VALUE_0=false
    [ -d "$WORK/$3" ] || git clone -q --depth 1 --branch "$2" "$1" "$WORK/$3"
}
fetch_tar() { # url dir
    if [ ! -d "$WORK/$2" ]; then
        (cd "$WORK" && curl -fsSL "$1" -o "$2.tar" && tar xf "$2.tar" && rm "$2.tar")
    fi
}
emcmake_build() { # srcdir builddir [cmake args...]
    local src=$1 bld=$2; shift 2
    emcmake cmake -S "$src" -B "$bld" -G Ninja -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF "$@" >/dev/null
    cmake --build "$bld" -j "$JOBS" >/dev/null
}
libdir() { mkdir -p "$OUT/$1/lib/$ABI" "$OUT/$1/include"; echo "$OUT/$1/lib/$ABI"; }

# ---- header-only -----------------------------------------------------------
dep_eigen() {
    fetch_git https://gitlab.com/libeigen/eigen.git 3.4.0 eigen
    mkdir -p "$OUT/eigen/include"
    cp -r "$WORK/eigen/Eigen" "$WORK/eigen/unsupported" "$OUT/eigen/include/"
}
dep_cgal() {
    # 5.6.2 (Android: 5.6) — the bug-fix releases make CGAL's BGL iterators
    # compile with recent clang; no API changes within 5.6.x.
    fetch_tar https://github.com/CGAL/cgal/releases/download/v5.6.2/CGAL-5.6.2.tar.xz CGAL-5.6.2
    rm -rf "$OUT/cgal/include"; mkdir -p "$OUT/cgal/include"
    cp -r "$WORK/CGAL-5.6.2/include/CGAL" "$OUT/cgal/include/"
}
dep_cereal() {
    fetch_git https://github.com/USCiLab/cereal.git v1.3.2 cereal
    mkdir -p "$OUT/cereal/include"
    cp -r "$WORK/cereal/include/cereal" "$OUT/cereal/include/"
}
dep_nlohmann() {
    fetch_git https://github.com/nlohmann/json.git v3.11.3 json
    mkdir -p "$OUT/nlohmann/include"
    cp -r "$WORK/json/include/nlohmann" "$OUT/nlohmann/include/"
}

# ---- compiled --------------------------------------------------------------
dep_zlib() {
    fetch_git https://github.com/madler/zlib.git v1.3.1 zlib
    emcmake_build "$WORK/zlib" "$WORK/zlib/build-wasm" -DZLIB_BUILD_EXAMPLES=OFF
    local L; L=$(libdir zlib)
    cp "$WORK/zlib/build-wasm/libz.a" "$L/"
    cp "$WORK/zlib/zlib.h" "$WORK/zlib/build-wasm/zconf.h" "$OUT/zlib/include/"
}
dep_expat() {
    fetch_git https://github.com/libexpat/libexpat.git R_2_6_2 libexpat
    emcmake_build "$WORK/libexpat/expat" "$WORK/libexpat/build-wasm" \
        -DEXPAT_BUILD_TOOLS=OFF -DEXPAT_BUILD_EXAMPLES=OFF -DEXPAT_BUILD_TESTS=OFF \
        -DEXPAT_BUILD_DOCS=OFF -DEXPAT_SHARED_LIBS=OFF
    local L; L=$(libdir expat)
    cp "$WORK/libexpat/build-wasm/libexpat.a" "$L/"
    cp "$WORK/libexpat/expat/lib/expat.h" "$WORK/libexpat/expat/lib/expat_external.h" "$OUT/expat/include/"
}
# libpng / libjpeg: real libraries (EdgeGrid.cpp, GCode/Thumbnails.cpp) instead
# of Android's header stubs. Built here rather than via Emscripten's
# -sUSE_LIBPNG ports so every input is a plain git clone.
dep_libpng() {
    fetch_git https://github.com/pnggroup/libpng.git v1.6.43 libpng
    emcmake_build "$WORK/libpng" "$WORK/libpng/build-wasm" \
        -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_EXECUTABLES=OFF \
        -DZLIB_INCLUDE_DIR="$OUT/zlib/include" -DZLIB_LIBRARY="$OUT/zlib/lib/$ABI/libz.a"
    local L; L=$(libdir libpng)
    cp "$WORK/libpng/build-wasm/libpng16.a" "$L/libpng.a"
    cp "$WORK/libpng/png.h" "$WORK/libpng/pngconf.h" "$WORK/libpng/build-wasm/pnglibconf.h" "$OUT/libpng/include/"
}
dep_libjpeg() {
    fetch_git https://github.com/libjpeg-turbo/libjpeg-turbo.git 3.0.3 libjpeg-turbo
    emcmake_build "$WORK/libjpeg-turbo" "$WORK/libjpeg-turbo/build-wasm" \
        -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF
    local L; L=$(libdir libjpeg)
    cp "$WORK/libjpeg-turbo/build-wasm/libjpeg.a" "$L/"
    cp "$WORK/libjpeg-turbo/jpeglib.h" "$WORK/libjpeg-turbo/jerror.h" "$WORK/libjpeg-turbo/jmorecfg.h" \
        "$WORK/libjpeg-turbo/build-wasm/jconfig.h" "$OUT/libjpeg/include/"
}
dep_tbb() {
    # Android uses 2021.11; Emscripten support (no x86 -mrtm/-mwaitpkg flags)
    # landed upstream in 2022.0, whose public API is unchanged for our use.
    fetch_git https://github.com/oneapi-src/oneTBB.git v2022.0.0 oneTBB-2022
    emcmake_build "$WORK/oneTBB-2022" "$WORK/oneTBB-2022/build-wasm" \
        -DTBB_TEST=OFF -DTBB_EXAMPLES=OFF -DTBB_STRICT=OFF -DTBBMALLOC_BUILD=ON \
        -DTBBMALLOC_PROXY_BUILD=OFF
    local L; L=$(libdir tbb)
    find "$WORK/oneTBB-2022/build-wasm" -name "*.a" -exec cp {} "$L/" \;
    cp -r "$WORK/oneTBB-2022/include/tbb" "$WORK/oneTBB-2022/include/oneapi" "$OUT/tbb/include/"
}
dep_nlopt() {
    # Same version OrcaSlicer's own deps/ pins. libnest2d's optimizers (Arrange.cpp)
    # need the real library; Android gets by with a header stub.
    fetch_git https://github.com/stevengj/nlopt.git v2.5.0 nlopt-2.5.0
    emcmake_build "$WORK/nlopt-2.5.0" "$WORK/nlopt-2.5.0/build-wasm" \
        -DNLOPT_PYTHON=OFF -DNLOPT_OCTAVE=OFF -DNLOPT_MATLAB=OFF -DNLOPT_GUILE=OFF \
        -DNLOPT_SWIG=OFF -DNLOPT_LINK_PYTHON=OFF -DNLOPT_CXX=ON
    local L; L=$(libdir nlopt)
    cp "$WORK/nlopt-2.5.0/build-wasm/libnlopt_cxx.a" "$L/libnlopt.a"
    cp "$WORK/nlopt-2.5.0/build-wasm/src/api/nlopt.h" "$WORK/nlopt-2.5.0/build-wasm/src/api/nlopt.hpp" \
        "$OUT/nlopt/include/"
}
# OCCT for STEP import — optional (not in ALL): `build-deps.sh occt`, then
# configure the engine with -DU1SLICER_WITH_STEP=ON. Same version + patch as
# OrcaSlicer's deps/OCCT (Android ships 7.8, whose API STEP.cpp doesn't build
# against). Only the DataExchange module and what it pulls in; no FreeType,
# no visualisation.
dep_occt() {
    fetch_git https://github.com/Open-Cascade-SAS/OCCT.git V7_6_0 OCCT-7.6.0
    local S="$WORK/OCCT-7.6.0"
    local ORCA_PATCH="$WASM_DIR/../app/src/main/cpp/orcaslicer/deps/OCCT/0001-OCCT-fix.patch"
    if [ ! -f "$S/.u1-patched" ]; then
        git -C "$S" apply --ignore-space-change --whitespace=fix "$ORCA_PATCH"
        # OCCT appends -fexceptions (Emscripten's JS exception model) after our
        # -fwasm-exceptions; mixing the two yields an invalid module
        # ("br_table: label arity inconsistent"). -fwasm-exceptions already
        # enables C++ exceptions.
        sed -i 's/ -fexceptions -fPIC")/ -fPIC")/' "$S/adm/cmake/occt_defs_flags.cmake"
        touch "$S/.u1-patched"
    fi
    emcmake_build "$S" "$S/build-wasm" \
        -DBUILD_LIBRARY_TYPE=Static -DINSTALL_DIR="$OUT/occt" -DINSTALL_DIR_LAYOUT=Unix \
        -DUSE_TK=OFF -DUSE_TBB=OFF -DUSE_FREETYPE=OFF -DUSE_FFMPEG=OFF -DUSE_VTK=OFF \
        -DUSE_OPENGL=OFF -DUSE_GLES2=OFF -DUSE_FREEIMAGE=OFF -DUSE_RAPIDJSON=OFF -DUSE_DRACO=OFF \
        -DBUILD_DOC_Overview=OFF -DBUILD_SAMPLES_QT=OFF \
        -DBUILD_MODULE_ApplicationFramework=OFF -DBUILD_MODULE_Draw=OFF \
        -DBUILD_MODULE_FoundationClasses=OFF -DBUILD_MODULE_ModelingAlgorithms=OFF \
        -DBUILD_MODULE_ModelingData=OFF -DBUILD_MODULE_Visualization=OFF \
        -DBUILD_MODULE_DataExchange=ON
    cmake --install "$S/build-wasm" >/dev/null
    local L; L=$(libdir occt)
    find "$OUT/occt/lib" -maxdepth 1 -name "*.a" -exec cp {} "$L/" \;
    rm -rf "$OUT/occt/include.real"; mv "$OUT/occt/include" "$OUT/occt/include.real"
    mkdir -p "$OUT/occt/include"
    # Flatten include/opencascade/*.hxx so <STEPCAFControl_Reader.hxx> resolves
    # with the same -I the Android bundle uses (extern/occt/include).
    cp -r "$OUT/occt/include.real"/opencascade*/* "$OUT/occt/include/"
    rm -rf "$OUT/occt/include.real"
}
dep_gmp() {
    local V=6.3.0
    fetch_tar "https://ftp.gnu.org/gnu/gmp/gmp-$V.tar.xz" "gmp-$V"
    (cd "$WORK/gmp-$V" && make distclean >/dev/null 2>&1 || true
     emconfigure ./configure --host=none --disable-assembly --disable-shared --enable-static \
         --enable-cxx --prefix="$OUT/gmp" CC_FOR_BUILD=gcc >/dev/null
     emmake make -j"$JOBS" >/dev/null && emmake make install >/dev/null)
    local L; L=$(libdir gmp)
    cp "$OUT/gmp/lib/libgmp.a" "$OUT/gmp/lib/libgmpxx.a" "$L/"
}
dep_mpfr() {
    local V=4.2.1
    fetch_tar "https://ftp.gnu.org/gnu/mpfr/mpfr-$V.tar.xz" "mpfr-$V"
    (cd "$WORK/mpfr-$V" && make distclean >/dev/null 2>&1 || true
     emconfigure ./configure --host=none --disable-shared --enable-static \
         --with-gmp="$OUT/gmp" --prefix="$OUT/mpfr" >/dev/null
     emmake make -j"$JOBS" >/dev/null && emmake make install >/dev/null)
    local L; L=$(libdir mpfr)
    cp "$OUT/mpfr/lib/libmpfr.a" "$L/"
}
dep_boost() {
    local V=1.84.0
    fetch_tar "https://github.com/boostorg/boost/releases/download/boost-$V/boost-$V.tar.xz" "boost-$V"
    local B="$WORK/boost-$V"
    (cd "$B"
     [ -x ./b2 ] || ./bootstrap.sh >/dev/null
     # b2's own `emscripten` toolset emits .bc archives that modern emcc rejects;
     # drive em++ through the clang toolset instead. pthread + wasm EH must match
     # the engine.
     cat > "$B/user-config-wasm.jam" <<'JAM'
using clang : emscripten : em++ : <archiver>emar <ranlib>emranlib ;
JAM
     ./b2 -q -j"$JOBS" --user-config="$B/user-config-wasm.jam" toolset=clang-emscripten \
         target-os=linux link=static threading=multi variant=release \
         runtime-link=static --layout=system \
         cxxflags="$FLAGS" cflags="$FLAGS" linkflags="$LDFLAGS" \
         define=BOOST_LOG_WITHOUT_SYSLOG define=BOOST_LOG_WITHOUT_EVENT_LOG \
         define=BOOST_LOG_WITHOUT_DEBUG_OUTPUT \
         boost.locale.icu=off boost.locale.iconv=off boost.locale.posix=on \
         -sNO_BZIP2=1 -sNO_LZMA=1 -sNO_ZSTD=1 -sZLIB_INCLUDE="$OUT/zlib/include" \
         -sZLIB_LIBRARY_PATH="$OUT/zlib/lib/$ABI" \
         --with-system --with-filesystem --with-thread --with-log --with-regex \
         --with-iostreams --with-nowide --with-chrono --with-atomic --with-date_time \
         --prefix="$OUT/boost" --libdir="$OUT/boost/lib/$ABI" \
         --includedir="$OUT/boost/include" install >"$WORK/boost-b2.log" 2>&1 \
        || { tail -40 "$WORK/boost-b2.log"; exit 1; })
}

ALL=(eigen cgal cereal nlohmann zlib expat libpng libjpeg tbb nlopt gmp mpfr boost)
DEPS=("${@:-${ALL[@]}}")
for d in "${DEPS[@]}"; do
    echo ">>> $d"
    "dep_$d"
done
echo ">>> done: $OUT"
