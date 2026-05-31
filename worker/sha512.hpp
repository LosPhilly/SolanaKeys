#ifndef SHA512_HPP
#define SHA512_HPP

#include <stdint.h>

// ------------------------------------------------------------------------
// CROSS-COMPATIBILITY BRIDGE (NVIDIA / AMD)
// ------------------------------------------------------------------------
// If compiling on AMD with hipcc, load the HIP runtime. 
// If compiling on NVIDIA with nvcc, it ignores this and uses native CUDA.
#if defined(__HIPCC__)
    #include <hip/hip_runtime.h>
#endif

// ------------------------------------------------------------------------
// MACROS & PURE C++ INTRINSICS
// ------------------------------------------------------------------------
// VERIFIED FIX: Pure C++ Rotation. Bypasses buggy PTX inline assembly.
#define ROTR64(x, n) (((x) >> (n)) | ((x) << (64 - (n))))

#define CH(x, y, z)  (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))

#define EP0(x) (ROTR64(x, 28) ^ ROTR64(x, 34) ^ ROTR64(x, 39))
#define EP1(x) (ROTR64(x, 14) ^ ROTR64(x, 18) ^ ROTR64(x, 41))
#define SIG0(x) (ROTR64(x, 1)  ^ ROTR64(x, 8)  ^ ((x) >> 7))
#define SIG1(x) (ROTR64(x, 19) ^ ROTR64(x, 61) ^ ((x) >> 6))

// VERIFIED FIX: Safe, compiler-optimized byte-swap. 
__device__ __forceinline__ uint64_t bswap_64(uint64_t x) {
    return 
        ((x & 0xFF00000000000000ULL) >> 56) |
        ((x & 0x00FF000000000000ULL) >> 40) |
        ((x & 0x0000FF0000000000ULL) >> 24) |
        ((x & 0x000000FF00000000ULL) >> 8)  |
        ((x & 0x00000000FF000000ULL) << 8)  |
        ((x & 0x0000000000FF0000ULL) << 24) |
        ((x & 0x000000000000FF00ULL) << 40) |
        ((x & 0x00000000000000FFULL) << 56);
}

// ------------------------------------------------------------------------
// THE COMPRESSION ROUNDS (Strict Dual-Stage Pipeline)
// ------------------------------------------------------------------------
#define ROUND_INIT(a, b, c, d, e, f, g, h, i, k) \
    do { \
        uint64_t t1 = h + EP1(e) + CH(e, f, g) + k + W[i]; \
        uint64_t t2 = EP0(a) + MAJ(a, b, c); \
        d += t1; \
        h = t1 + t2; \
    } while(0)

#define ROUND_EXPAND(a, b, c, d, e, f, g, h, i, k) \
    do { \
        W[i & 15] += SIG1(W[(i - 2) & 15]) + W[(i - 7) & 15] + SIG0(W[(i - 15) & 15]); \
        uint64_t t1 = h + EP1(e) + CH(e, f, g) + k + W[i & 15]; \
        uint64_t t2 = EP0(a) + MAJ(a, b, c); \
        d += t1; \
        h = t1 + t2; \
    } while(0)

// ------------------------------------------------------------------------
// HIGH-PERFORMANCE SHA-512 KERNEL (32-Byte Strict)
// ------------------------------------------------------------------------
__device__ __forceinline__ void sha512_32bytes(const uint8_t* in_seed, uint8_t* out_hash) {
    uint64_t a = 0x6a09e667f3bcc908;
    uint64_t b = 0xbb67ae8584caa73b;
    uint64_t c = 0x3c6ef372fe94f82b;
    uint64_t d = 0xa54ff53a5f1d36f1;
    uint64_t e = 0x510e527fade682d1;
    uint64_t f = 0x9b05688c2b3e6c1f;
    uint64_t g = 0x1f83d9abfb41bd6b;
    uint64_t h = 0x5be0cd19137e2179;

    uint64_t W[16];
    
    // Standard Big-Endian Data Ingestion
    const uint64_t* in64 = (const uint64_t*)in_seed;
    W[0] = bswap_64(in64[0]);
    W[1] = bswap_64(in64[1]);
    W[2] = bswap_64(in64[2]);
    W[3] = bswap_64(in64[3]);

    // FIPS 180-4 Correct Padding for 256-bit message
    W[4] = 0x8000000000000000ULL; 
    W[5] = 0; W[6] = 0; W[7] = 0; W[8] = 0; W[9] = 0;
    W[10]= 0; W[11]= 0; W[12]= 0; W[13]= 0; W[14]= 0;
    W[15] = 256; 

    // Rounds 0-15: Initial Schedule (No Expansion)
    ROUND_INIT(a, b, c, d, e, f, g, h,  0, 0x428a2f98d728ae22);
    ROUND_INIT(h, a, b, c, d, e, f, g,  1, 0x7137449123ef65cd);
    ROUND_INIT(g, h, a, b, c, d, e, f,  2, 0xb5c0fbcfec4d3b2f);
    ROUND_INIT(f, g, h, a, b, c, d, e,  3, 0xe9b5dba58189dbbc);
    ROUND_INIT(e, f, g, h, a, b, c, d,  4, 0x3956c25bf348b538);
    ROUND_INIT(d, e, f, g, h, a, b, c,  5, 0x59f111f1b605d019);
    ROUND_INIT(c, d, e, f, g, h, a, b,  6, 0x923f82a4af194f9b);
    ROUND_INIT(b, c, d, e, f, g, h, a,  7, 0xab1c5ed5da6d8118);
    ROUND_INIT(a, b, c, d, e, f, g, h,  8, 0xd807aa98a3030242);
    ROUND_INIT(h, a, b, c, d, e, f, g,  9, 0x12835b0145706fbe);
    ROUND_INIT(g, h, a, b, c, d, e, f, 10, 0x243185be4ee4b28c);
    ROUND_INIT(f, g, h, a, b, c, d, e, 11, 0x550c7dc3d5ffb4e2);
    ROUND_INIT(e, f, g, h, a, b, c, d, 12, 0x72be5d74f27b896f);
    ROUND_INIT(d, e, f, g, h, a, b, c, 13, 0x80deb1fe3b1696b1);
    ROUND_INIT(c, d, e, f, g, h, a, b, 14, 0x9bdc06a725c71235);
    ROUND_INIT(b, c, d, e, f, g, h, a, 15, 0xc19bf174cf692694);

    // Rounds 16-31: Rolling Window Schedule Expansion
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 16, 0xe49b69c19ef14ad2);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 17, 0xefbe4786384f25e3);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 18, 0x0fc19dc68b8cd5b5);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 19, 0x240ca1cc77ac9c65);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 20, 0x2de92c6f592b0275);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 21, 0x4a7484aa6ea6e483);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 22, 0x5cb0a9dcbd41fbd4);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 23, 0x76f988da831153b5);
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 24, 0x983e5152ee66dfab);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 25, 0xa831c66d2db43210);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 26, 0xb00327c898fb213f);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 27, 0xbf597fc7beef0ee4);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 28, 0xc6e00bf33da88fc2);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 29, 0xd5a79147930aa725);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 30, 0x06ca6351e003826f);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 31, 0x142929670a0e6e70);

    // Rounds 32-47
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 32, 0x27b70a8546d22ffc);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 33, 0x2e1b21385c26c926);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 34, 0x4d2c6dfc5ac42aed);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 35, 0x53380d139d95b3df);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 36, 0x650a73548baf63de);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 37, 0x766a0abb3c77b2a8);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 38, 0x81c2c92e47edaee6);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 39, 0x92722c851482353b);
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 40, 0xa2bfe8a14cf10364);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 41, 0xa81a664bbc423001);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 42, 0xc24b8b70d0f89791);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 43, 0xc76c51a30654be30);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 44, 0xd192e819d6ef5218);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 45, 0xd69906245565a910);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 46, 0xf40e35855771202a);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 47, 0x106aa07032bbd1b8);

    // Rounds 48-63
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 48, 0x19a4c116b8d2d0c8);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 49, 0x1e376c085141ab53);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 50, 0x2748774cdf8eeb99);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 51, 0x34b0bcb5e19b48a8);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 52, 0x391c0cb3c5c95a63);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 53, 0x4ed8aa4ae3418acb);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 54, 0x5b9cca4f7763e373);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 55, 0x682e6ff3d6b2b8a3);
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 56, 0x748f82ee5defb2fc);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 57, 0x78a5636f43172f60);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 58, 0x84c87814a1f0ab72);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 59, 0x8cc702081a6439ec);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 60, 0x90befffa23631e28);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 61, 0xa4506cebde82bde9);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 62, 0xbef9a3f7b2c67915);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 63, 0xc67178f2e372532b);

    // Rounds 64-79: Fully Intact
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 64, 0xca273eceea26619c);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 65, 0xd186b8c721c0c207);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 66, 0xeada7dd6cde0eb1e);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 67, 0xf57d4f7fee6ed178);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 68, 0x06f067aa72176fba);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 69, 0x0a637dc5a2c898a6);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 70, 0x113f9804bef90dae);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 71, 0x1b710b35131c471b);
    ROUND_EXPAND(a, b, c, d, e, f, g, h, 72, 0x28db77f523047d84);
    ROUND_EXPAND(h, a, b, c, d, e, f, g, 73, 0x32caab7b40c72493);
    ROUND_EXPAND(g, h, a, b, c, d, e, f, 74, 0x3c9ebe0a15c9bebc);
    ROUND_EXPAND(f, g, h, a, b, c, d, e, 75, 0x431d67c49c100d4c);
    ROUND_EXPAND(e, f, g, h, a, b, c, d, 76, 0x4cc5d4becb3e42b6);
    ROUND_EXPAND(d, e, f, g, h, a, b, c, 77, 0x597f299cfc657e2a);
    ROUND_EXPAND(c, d, e, f, g, h, a, b, 78, 0x5fcb6fab3ad6faec);
    ROUND_EXPAND(b, c, d, e, f, g, h, a, 79, 0x6c44198c4a475817);

    // Standard Little-Endian Output Conversion
    uint64_t* out64 = (uint64_t*)out_hash;
    out64[0] = bswap_64(a + 0x6a09e667f3bcc908);
    out64[1] = bswap_64(b + 0xbb67ae8584caa73b);
    out64[2] = bswap_64(c + 0x3c6ef372fe94f82b);
    out64[3] = bswap_64(d + 0xa54ff53a5f1d36f1);
    out64[4] = bswap_64(e + 0x510e527fade682d1);
    out64[5] = bswap_64(f + 0x9b05688c2b3e6c1f);
    out64[6] = bswap_64(g + 0x1f83d9abfb41bd6b);
    out64[7] = bswap_64(h + 0x5be0cd19137e2179);
}

#endif // SHA512_HPP