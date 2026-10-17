// WASM build: minimal OpenSSL MD5 API on top of Boost's header-only MD5.
// libslic3r only uses MD5_Init/Update/Final (file checksums in utils.cpp and
// bbs_3mf.cpp); pulling OpenSSL into the wasm module for that is not worth it.
#pragma once

#include <boost/uuid/detail/md5.hpp>
#include <cstddef>
#include <cstdint>

#define MD5_DIGEST_LENGTH 16

struct MD5_CTX {
    boost::uuids::detail::md5 h;
};

inline int MD5_Init(MD5_CTX* c) {
    c->h = boost::uuids::detail::md5();
    return 1;
}

inline int MD5_Update(MD5_CTX* c, const void* data, size_t len) {
    c->h.process_bytes(data, len);
    return 1;
}

inline int MD5_Final(unsigned char* md, MD5_CTX* c) {
    boost::uuids::detail::md5::digest_type d;
    c->h.get_digest(d);
    // Boost stores the digest as four 32-bit words in native (little-endian on
    // wasm) order; emit the canonical big-endian byte order OpenSSL uses.
    for (int i = 0; i < 4; ++i) {
        const uint32_t w = d[i];
        md[i * 4 + 0] = static_cast<unsigned char>((w >> 24) & 0xff);
        md[i * 4 + 1] = static_cast<unsigned char>((w >> 16) & 0xff);
        md[i * 4 + 2] = static_cast<unsigned char>((w >> 8) & 0xff);
        md[i * 4 + 3] = static_cast<unsigned char>(w & 0xff);
    }
    return 1;
}
