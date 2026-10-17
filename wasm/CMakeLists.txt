# =============================================================================
# WASM spike — build the Android app's slicing engine (libslic3r + sapil core)
# outside Android. See wasm/README.md.
#
# WebAssembly (the spike):
#   source <emsdk>/emsdk_env.sh
#   wasm/scripts/build-deps.sh
#   emcmake cmake -S wasm -B wasm/build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build wasm/build/engine            # -> u1slicer.js + u1slicer.wasm
#
# Native host reference (same engine, system packages, 64-bit):
#   cmake -S wasm -B wasm/build/host -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build wasm/build/host              # -> u1slicer-host
# =============================================================================
cmake_minimum_required(VERSION 3.22)
project(u1slicer_wasm LANGUAGES C CXX)

set(APP_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../app/src/main/cpp")
set(SAPIL_WASM_STUB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/stubs")
set(SLICER_BACKEND "orca" CACHE STRING "" FORCE)
set(SAPIL_STANDALONE ON)
# STEP import via OCCT 7.6 (wasm/scripts/build-deps.sh occt). Off by default:
# it adds several MB to the module. Build it into its own dir, e.g.
#   emcmake cmake -S wasm -B wasm/build/engine-step -DU1SLICER_WITH_STEP=ON ...
option(U1SLICER_WITH_STEP "Real STEP import (needs the occt dep)" OFF)
set(SAPIL_WITH_STEP ${U1SLICER_WITH_STEP})

if(EMSCRIPTEN)
    set(EXTERN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/build/deps" CACHE PATH "Output of wasm/scripts/build-deps.sh")
    set(DEP_LIB_ARCH wasm32)
    # Must match wasm/scripts/build-deps.sh: every object in the link shares one
    # exception model and the shared-memory (pthread) ABI.
    add_compile_options(-pthread -fwasm-exceptions)
    add_link_options(-pthread -fwasm-exceptions)
    # wasm32 has a 32-bit size_t. Orca initialises size_t sentinels from
    # numeric_limits<coord_t /* int64 */>::max() (GCode.hpp LayerResult); the
    # value truncates to SIZE_MAX, which is still the "no layer" sentinel. Clang
    # makes that narrowing a hard error by default; keep it a warning.
    add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-Wno-c++11-narrowing>)
    # Emscripten's clang is much newer than NDK 26's clang 17 and rejects
    # `x.template foo` without an argument list in Boost.QVM / CGAL headers.
    add_compile_options($<$<COMPILE_LANGUAGE:CXX>:-Wno-missing-template-arg-list-after-template-kw>)
    # WebAssembly cannot change the FPU rounding mode, which CGAL's interval
    # arithmetic (the filter behind every Epick predicate) relies on. Without
    # this, NDEBUG builds silently compute unsound intervals — CGAL's own
    # self-test "-CGAL_IA_MUL(-1.1, 10.1) != CGAL_IA_MUL(1.1, 10.1)" fails when
    # assertions are on — so exact-predicate results (VoronoiUtilsCgal,
    # MeshBoolean, CutSurface) can be wrong. CGAL's supported fallback widens
    # each bound by one ulp via nextafter().
    add_compile_definitions(CGAL_ALWAYS_ROUND_TO_NEAREST=1)
else()
    # Host reference build: deps come from the system (Ubuntu: libboost-all-dev
    # libtbb-dev libgmp-dev libmpfr-dev libcgal-dev libnlopt-cxx-dev
    # libexpat1-dev libpng-dev libjpeg-dev libeigen3-dev nlohmann-json3-dev
    # libcereal-dev). EXTERN_DIR only has to exist for the include/link paths.
    set(EXTERN_DIR "${CMAKE_CURRENT_BINARY_DIR}/no-extern" CACHE PATH "")
    set(DEP_LIB_ARCH ${CMAKE_SYSTEM_PROCESSOR})
    include_directories(/usr/include/eigen3)
    # Distro Boost is shared; the engine otherwise assumes static Boost.Log.
    add_compile_definitions(BOOST_LOG_DYN_LINK=1)
endif()

# Engine source patches (wasm/patches/*.patch, paths relative to the orcaslicer
# submodule). The submodule itself stays untouched: each patched file is copied
# into the build tree, patched there, and swapped into libslic3r's source list
# by the shared CMakeLists (SAPIL_SOURCE_OVERRIDES). Only bugs that the wasm
# build exposes belong here; upstream them to the Orca fork when possible.
set(SAPIL_PATCHED_DIR "${CMAKE_BINARY_DIR}/patched-engine")
set(SAPIL_SOURCE_OVERRIDES "")
file(GLOB ENGINE_PATCHES "${CMAKE_CURRENT_SOURCE_DIR}/patches/*.patch")
foreach(patch ${ENGINE_PATCHES})
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${patch})
    file(STRINGS ${patch} touched REGEX "^\\+\\+\\+ b/")
    foreach(line ${touched})
        string(REGEX REPLACE "^\\+\\+\\+ b/" "" rel "${line}")
        list(APPEND SAPIL_SOURCE_OVERRIDES ${rel})
    endforeach()
endforeach()
list(REMOVE_DUPLICATES SAPIL_SOURCE_OVERRIDES)
foreach(rel ${SAPIL_SOURCE_OVERRIDES})  # fresh originals first, then all patches
    configure_file("${APP_CPP_DIR}/orcaslicer/${rel}" "${SAPIL_PATCHED_DIR}/${rel}" COPYONLY)
endforeach()
foreach(patch ${ENGINE_PATCHES})
    execute_process(COMMAND patch -p1 --forward --silent -d "${SAPIL_PATCHED_DIR}" -i "${patch}"
                    RESULT_VARIABLE rc)
    if(NOT rc EQUAL 0)
        message(FATAL_ERROR "Engine patch failed to apply: ${patch}")
    endif()
endforeach()

# Engine: identical source lists / defines to the Android .so; the shared
# CMakeLists stops before its JNI target when SAPIL_STANDALONE is set.
add_subdirectory(${APP_CPP_DIR} engine)

# libslic3r links its deps by bare name (-lboost_log, -ltbb, ...); the search
# paths are directory-scoped in the engine CMakeLists, so repeat them here.
foreach(dep boost tbb gmp mpfr zlib expat nlopt libpng libjpeg occt)
    link_directories("${EXTERN_DIR}/${dep}/lib/${DEP_LIB_ARCH}")
endforeach()

# sapil core (no JNI). Kotlin-facing sapil_config/progress/bambu_* + the JNI
# entry points in slicer_wrapper.cpp are replaced by src/wasm_api.cpp
# (wasm) / src/host_cli.cpp (native).
set(SAPIL_CORE_SOURCES
    ${APP_CPP_DIR}/src/sapil_model.cpp
    ${APP_CPP_DIR}/src/sapil_print.cpp
    ${APP_CPP_DIR}/src/sapil_arrange.cpp
    ${APP_CPP_DIR}/src/sapil_gcode.cpp
    ${APP_CPP_DIR}/src/sapil_diagnostics.cpp
    ${APP_CPP_DIR}/src/sapil_bambu_snapshot.cpp
)
if(EMSCRIPTEN)
    set(TARGET u1slicer)
    add_executable(${TARGET} ${SAPIL_CORE_SOURCES} src/wasm_api.cpp)
else()
    set(TARGET u1slicer-host)
    add_executable(${TARGET} ${SAPIL_CORE_SOURCES} src/host_cli.cpp)
endif()

# The JNI target inherits the engine directory's defines / include dirs /
# force-included compat header; mirror them so sapil compiles identically.
get_directory_property(ENGINE_DEFS DIRECTORY ${APP_CPP_DIR} COMPILE_DEFINITIONS)
get_directory_property(ENGINE_INCS DIRECTORY ${APP_CPP_DIR} INCLUDE_DIRECTORIES)
get_directory_property(ENGINE_OPTS DIRECTORY ${APP_CPP_DIR} COMPILE_OPTIONS)
target_compile_definitions(${TARGET} PRIVATE ${ENGINE_DEFS} SAPIL_HAS_JNI=0)
target_include_directories(${TARGET} PRIVATE ${APP_CPP_DIR}/include ${APP_CPP_DIR}/src ${ENGINE_INCS})
target_compile_options(${TARGET} PRIVATE ${ENGINE_OPTS})
target_link_libraries(${TARGET} PRIVATE libslic3r)

if(NOT EMSCRIPTEN)
    return()
endif()

target_link_libraries(u1slicer PRIVATE embind)
set_target_properties(u1slicer PROPERTIES SUFFIX ".js")
target_link_options(u1slicer PRIVATE
    -sMODULARIZE=1
    -sEXPORT_NAME=createU1Slicer
    -sENVIRONMENT=web,worker,node
    -sEXPORTED_RUNTIME_METHODS=FS
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=256MB
    -sMAXIMUM_MEMORY=4GB
    -sSTACK_SIZE=8MB
    -sPTHREAD_POOL_SIZE=0
)
option(U1SLICER_WASM_DEBUG "Runtime assertions + symbolised stacks" OFF)
if(U1SLICER_WASM_DEBUG)
    target_link_options(u1slicer PRIVATE -sASSERTIONS=2 --profiling-funcs
        -sSAFE_HEAP=1 -sSTACK_OVERFLOW_CHECK=2)
endif()
