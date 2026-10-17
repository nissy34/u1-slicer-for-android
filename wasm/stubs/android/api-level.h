// WASM build: a handful of Orca translation units are compiled with
// __ANDROID__ defined so they take the Snapmaker-U1 code paths (see the
// EMSCRIPTEN block in app/src/main/cpp/CMakeLists.txt). oneTBB's _config.h then
// includes this NDK header; give it the API level the Android build targets.
#pragma once
#ifndef __ANDROID_API__
#define __ANDROID_API__ 26
#endif
