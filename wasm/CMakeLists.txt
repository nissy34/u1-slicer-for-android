# =============================================================================
# WASM spike — build the Android app's slicing engine (libslic3r + sapil core)
# with Emscripten. See wasm/README.md.
#
#   source <emsdk>/emsdk_env.sh
#   wasm/scripts/build-deps.sh
#   emcmake cmake -S wasm -B wasm/build/engine -G Ninja -DCMAKE_BUILD_TYPE=Release
#   cmake --build wasm/build/engine
# =============================================================================
cmake_minimum_required(VERSION 3.22)
project(u1slicer_wasm LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "Configure with emcmake (Emscripten toolchain)")
endif()

set(APP_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../app/src/main/cpp")
set(EXTERN_DIR "${CMAKE_CURRENT_SOURCE_DIR}/build/deps" CACHE PATH "Output of wasm/scripts/build-deps.sh")
set(SAPIL_WASM_STUB_DIR "${CMAKE_CURRENT_SOURCE_DIR}/stubs")
set(SLICER_BACKEND "orca" CACHE STRING "" FORCE)

# Must match wasm/scripts/build-deps.sh: every object in the link shares one
# exception model and the shared-memory (pthread) ABI.
add_compile_options(-pthread -fwasm-exceptions)
add_link_options(-pthread -fwasm-exceptions)

# Engine: identical source lists / defines to the Android .so; the shared
# CMakeLists stops before its JNI target when EMSCRIPTEN is set.
add_subdirectory(${APP_CPP_DIR} engine)

# sapil core (no JNI). Kotlin-facing sapil_config/progress/bambu_* + the JNI
# entry points in slicer_wrapper.cpp are replaced by src/wasm_api.cpp.
add_executable(u1slicer
    ${APP_CPP_DIR}/src/sapil_model.cpp
    ${APP_CPP_DIR}/src/sapil_print.cpp
    ${APP_CPP_DIR}/src/sapil_arrange.cpp
    ${APP_CPP_DIR}/src/sapil_gcode.cpp
    ${APP_CPP_DIR}/src/sapil_diagnostics.cpp
    ${APP_CPP_DIR}/src/sapil_bambu_snapshot.cpp
    src/wasm_api.cpp
)
# The JNI target inherits the engine directory's defines / include dirs /
# force-included compat header; mirror them so sapil compiles identically.
get_directory_property(ENGINE_DEFS DIRECTORY ${APP_CPP_DIR} COMPILE_DEFINITIONS)
get_directory_property(ENGINE_INCS DIRECTORY ${APP_CPP_DIR} INCLUDE_DIRECTORIES)
get_directory_property(ENGINE_OPTS DIRECTORY ${APP_CPP_DIR} COMPILE_OPTIONS)
target_compile_definitions(u1slicer PRIVATE ${ENGINE_DEFS} SAPIL_HAS_JNI=0)
target_include_directories(u1slicer PRIVATE ${APP_CPP_DIR}/include ${APP_CPP_DIR}/src ${ENGINE_INCS})
target_compile_options(u1slicer PRIVATE ${ENGINE_OPTS})
target_link_libraries(u1slicer PRIVATE libslic3r embind)

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
