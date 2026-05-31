#ifndef ED25519_DEVICE_CUH
#define ED25519_DEVICE_CUH

#include <stdint.h>

// =========================================================================
// 1. DATA STRUCTURES: FIELD ELEMENTS & EXTENDED COORDINATES
// =========================================================================
struct u256 {
    uint64_t l0, l1, l2, l3; 
};
typedef u256 fe;

struct ge_ext {
    fe X, Y, Z, T;
};

// High-speed, branchless character-to-index mapping for Base58 filtering
__device__ __forceinline__ int b58_char_to_index(char c) {
    if (c >= '1' && c <= '9') return c - '1';
    if (c >= 'A' && c <= 'H') return c - 'A' + 9;
    if (c >= 'J' && c <= 'N') return c - 'J' + 17;
    if (c >= 'P' && c <= 'Z') return c - 'P' + 22;
    if (c >= 'a' && c <= 'k') return c - 'a' + 33;
    if (c >= 'm' && c <= 'z') return c - 'm' + 44;
    return -1;
}

// =========================================================================
// 2. PRIME FIELD REDUCTION (Modulo 2^255 - 19)
// =========================================================================
__device__ __forceinline__ void fe_reduce(fe &r) {
    uint64_t over = r.l3 >> 63;
    r.l3 &= 0x7FFFFFFFFFFFFFFF;
    uint64_t c = over * 19;
    
    asm volatile(
        "add.cc.u64    %0, %0, %4;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        : "+l"(r.l0), "+l"(r.l1), "+l"(r.l2), "+l"(r.l3) : "l"(c)
    );

    uint64_t over2 = r.l3 >> 63;
    r.l3 &= 0x7FFFFFFFFFFFFFFF;
    uint64_t c2 = over2 * 19;

    asm volatile(
        "add.cc.u64    %0, %0, %4;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        : "+l"(r.l0), "+l"(r.l1), "+l"(r.l2), "+l"(r.l3) : "l"(c2)
    );
}

__device__ __forceinline__ void fe_strong_reduce(fe &r) {
    fe temp = r;
    uint64_t c = 19;
    asm volatile(
        "add.cc.u64    %0, %0, %4;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        : "+l"(temp.l0), "+l"(temp.l1), "+l"(temp.l2), "+l"(temp.l3) : "l"(c)
    );
    if (temp.l3 >> 63) {
        temp.l3 &= 0x7FFFFFFFFFFFFFFF;
        r = temp;
    }
}

// =========================================================================
// 3. HARDWARE INTRINSICS: FIELD ARITHMETIC
// =========================================================================
__device__ __forceinline__ void fe_add(fe &r, const fe &a, const fe &b) {
    asm volatile(
        "add.cc.u64    %0, %4, %8;\n\t"
        "addc.cc.u64   %1, %5, %9;\n\t"
        "addc.cc.u64   %2, %6, %10;\n\t"
        "addc.u64      %3, %7, %11;\n\t"
        : "=l"(r.l0), "=l"(r.l1), "=l"(r.l2), "=l"(r.l3)
        : "l"(a.l0), "l"(a.l1), "l"(a.l2), "l"(a.l3), "l"(b.l0), "l"(b.l1), "l"(b.l2), "l"(b.l3)
    );
    fe_reduce(r);
}

__device__ __forceinline__ void fe_sub(fe &r, const fe &a, const fe &b) {
    uint64_t borrow;
    asm volatile(
        "sub.cc.u64    %0, %5, %9;\n\t"
        "subc.cc.u64   %1, %6, %10;\n\t"
        "subc.cc.u64   %2, %7, %11;\n\t"
        "subc.cc.u64   %3, %8, %12;\n\t"
        "subc.u64      %4, 0, 0;\n\t"
        : "=l"(r.l0), "=l"(r.l1), "=l"(r.l2), "=l"(r.l3), "=l"(borrow)
        : "l"(a.l0), "l"(a.l1), "l"(a.l2), "l"(a.l3), "l"(b.l0), "l"(b.l1), "l"(b.l2), "l"(b.l3)
    );
    
    uint64_t c = (borrow & 1) * 38;
    asm volatile(
        "sub.cc.u64    %0, %0, %4;\n\t"
        "subc.cc.u64   %1, %1, 0;\n\t"
        "subc.cc.u64   %2, %2, 0;\n\t"
        "subc.u64      %3, %3, 0;\n\t"
        : "+l"(r.l0), "+l"(r.l1), "+l"(r.l2), "+l"(r.l3) : "l"(c)
    );
    fe_reduce(r);
}

// ULTRA-ACCELERATED INLINE PTX FIELD MULTIPLICATION
__device__ __forceinline__ void fe_mul(fe &r, const fe &a, const fe &b) {
    uint64_t t0, t1, t2, t3, t4, t5, t6, t7;

    asm volatile (
        "mul.lo.u64       %0,  %8,  %12;\n\t"
        "mul.hi.u64       %1,  %8,  %12;\n\t"
        "mad.lo.cc.u64    %1,  %8,  %13, %1;\n\t"
        "mad.hi.cc.u64    %2,  %8,  %13, 0;\n\t"
        "madc.lo.cc.u64   %2,  %8,  %14, %2;\n\t"
        "madc.hi.cc.u64   %3,  %8,  %14, 0;\n\t"
        "madc.lo.cc.u64   %3,  %8,  %15, %3;\n\t"
        "madc.hi.u64      %4,  %8,  %15, 0;\n\t"

        "mad.lo.cc.u64    %1,  %9,  %12, %1;\n\t"
        "madc.hi.cc.u64   %2,  %9,  %12, %2;\n\t"
        "madc.lo.cc.u64   %2,  %9,  %13, %2;\n\t"
        "madc.hi.cc.u64   %3,  %9,  %13, %3;\n\t"
        "madc.lo.cc.u64   %3,  %9,  %14, %3;\n\t"
        "madc.hi.cc.u64   %4,  %9,  %14, %4;\n\t"
        "madc.lo.cc.u64   %4,  %9,  %15, %4;\n\t"
        "madc.hi.u64      %5,  %9,  %15, 0;\n\t"

        "mad.lo.cc.u64    %2,  %10, %12, %2;\n\t"
        "madc.hi.cc.u64   %3,  %10, %12, %3;\n\t"
        "madc.lo.cc.u64   %3,  %10, %13, %3;\n\t"
        "madc.hi.cc.u64   %4,  %10, %13, %4;\n\t"
        "madc.lo.cc.u64   %4,  %10, %14, %4;\n\t"
        "madc.hi.cc.u64   %5,  %10, %14, %5;\n\t"
        "madc.lo.cc.u64   %5,  %10, %15, %5;\n\t"
        "madc.hi.u64      %6,  %10, %15, 0;\n\t"

        "mad.lo.cc.u64    %3,  %11, %12, %3;\n\t"
        "madc.hi.cc.u64   %4,  %11, %12, %4;\n\t"
        "madc.lo.cc.u64   %4,  %11, %13, %4;\n\t"
        "madc.hi.cc.u64   %5,  %11, %13, %5;\n\t"
        "madc.lo.cc.u64   %5,  %11, %14, %5;\n\t"
        "madc.hi.cc.u64   %6,  %11, %14, %6;\n\t"
        "madc.lo.cc.u64   %6,  %11, %15, %6;\n\t"
        "madc.hi.u64      %7,  %11, %15, 0;\n\t"
        : "=&l"(t0), "=&l"(t1), "=&l"(t2), "=&l"(t3), "=&l"(t4), "=&l"(t5), "=&l"(t6), "=&l"(t7)
        : "l"(a.l0), "l"(a.l1), "l"(a.l2), "l"(a.l3), "l"(b.l0), "l"(b.l1), "l"(b.l2), "l"(b.l3)
    );

    // Dynamic hardware fold mapping modulo 2^255 - 19 using radix-38 scales
    asm volatile (
        "mad.lo.cc.u64    %0,  %4,  38, %0;\n\t"
        "madc.hi.cc.u64   %1,  %4,  38, %1;\n\t"
        "madc.lo.cc.u64   %1,  %5,  38, %1;\n\t"
        "madc.hi.cc.u64   %2,  %5,  38, %2;\n\t"
        "madc.lo.cc.u64   %2,  %6,  38, %2;\n\t"
        "madc.hi.cc.u64   %3,  %6,  38, %3;\n\t"
        "madc.lo.cc.u64   %3,  %7,  38, %3;\n\t"
        "madc.hi.u64      %4,  %7,  38, 0;\n\t"
        : "+l"(t0), "+l"(t1), "+l"(t2), "+l"(t3), "=&l"(t4)
    );

    uint64_t final_fold = t4 * 38;
    asm volatile (
        "add.cc.u64    %0, %4, %8;\n\t"
        "addc.cc.u64   %1, %5, 0;\n\t"
        "addc.cc.u64   %2, %6, 0;\n\t"
        "addc.u64      %3, %7, 0;\n\t"
        : "=l"(r.l0), "=l"(r.l1), "=l"(r.l2), "=l"(r.l3)
        : "l"(t0), "l"(t1), "l"(t2), "l"(t3), "l"(final_fold)
    );

    fe_reduce(r);
}

__device__ __forceinline__ void fe_sqr(fe &r, const fe &a) {
    fe_mul(r, a, a);
}

__device__ __forceinline__ void fe_invert(fe &out, const fe &z) {
    fe result = z;
    for (int i = 253; i >= 0; i--) {
        fe_sqr(result, result);
        if (i != 2 && i != 4) {
            fe_mul(result, result, z);
        }
    }
    out = result;
}

// =========================================================================
// 4. TWISTED EDWARDS CURVE OPERATIONS (STRICT EFD MAPPING)
// =========================================================================
__device__ __forceinline__ void ge_add_ext(ge_ext &r, const ge_ext &p, const ge_ext &q, const fe &d2) {
    fe A, B, C, D, E, F, G, H;
    fe t0, t1;
    
    fe_sub(t0, p.Y, p.X);
    fe_sub(t1, q.Y, q.X);
    fe_mul(A, t0, t1);
    
    fe_add(t0, p.Y, p.X);
    fe_add(t1, q.Y, q.X);
    fe_mul(B, t0, t1);
    
    fe_mul(C, p.T, q.T);
    fe_mul(C, C, d2);
    
    fe_mul(D, p.Z, q.Z);
    fe_add(D, D, D);
    
    fe_sub(E, B, A);
    fe_sub(F, D, C);
    fe_add(G, D, C);
    fe_add(H, B, A);
    
    fe_mul(r.X, E, F);
    fe_mul(r.Y, G, H);
    fe_mul(r.T, E, H);
    fe_mul(r.Z, F, G);
}

__device__ __forceinline__ void ge_double(ge_ext &r, const ge_ext &p) {
    fe A, B, C, H, E, G, F;
    fe t0;
    
    fe_sqr(A, p.X);
    fe_sqr(B, p.Y);
    fe_sqr(C, p.Z); fe_add(C, C, C);
    fe_add(H, A, B);
    
    fe_add(t0, p.X, p.Y);
    fe_sqr(t0, t0);
    fe_sub(E, H, t0);
    
    fe_sub(G, A, B);
    fe_add(F, C, G);
    
    fe_mul(r.X, E, F);
    fe_mul(r.Y, G, H);
    fe_mul(r.T, E, H);
    fe_mul(r.Z, F, G);
}

// =========================================================================
// 5. RADIX-4 (2-BIT WINDOW) PRECOMPUTATION UTILITY
// =========================================================================
__device__ void populate_window_table_r4(ge_ext *table, ge_ext base, const fe &d2) {
    table[0] = base;                         // 1 * B
    ge_double(table[1], base);               // 2 * B
    ge_add_ext(table[2], table[1], base, d2); // 3 * B
}

// =========================================================================
// THE MASTER SCALAR MULTIPLICATION (Accelerated 2-Bit Window / Radix-4)
// =========================================================================
__device__ __forceinline__ void ge_scalarmult_base(ge_ext &r, const uint8_t *scalar) {
    fe fe_121665 = {121665, 0, 0, 0};
    fe fe_121666 = {121666, 0, 0, 0};
    fe inv; fe_invert(inv, fe_121666);
    fe d; fe_mul(d, fe_121665, inv);
    fe zero = {0,0,0,0};
    fe_sub(d, zero, d); 
    fe d2; fe_add(d2, d, d); 

    fe B_x = {0xc9562d608f25d51a, 0x692cc7609525a7b2, 0xc0a4e231fdd6dc5c, 0x216936d3cd6e53fe};
    fe B_y = {0x6666666666666658, 0x6666666666666666, 0x6666666666666666, 0x6666666666666666};
    fe B_z = {1, 0, 0, 0};
    fe B_t; fe_mul(B_t, B_x, B_y); 
    ge_ext base = {B_x, B_y, B_z, B_t};
    
    // Radix-4 Table: Only 3 elements. Fits natively in clean registers!
    ge_ext window_table[3];
    populate_window_table_r4(window_table, base, d2);

    fe one = {1,0,0,0};
    r = {zero, one, one, zero}; 
    bool first_addition = true;

    // Evaluate 128 windows (2 bits per iteration) from MSB to LSB
    for (int i = 31; i >= 0; i--) {
        uint8_t byte = scalar[i];
        
        #pragma unroll
        for (int shift = 6; shift >= 0; shift -= 2) {
            uint8_t window_val = (byte >> shift) & 0x03;
            
            if (!first_addition) {
                ge_double(r, r);
                ge_double(r, r);
            }
            
            if (window_val > 0) {
                if (first_addition) {
                    r = window_table[window_val - 1];
                    first_addition = false;
                } else {
                    ge_add_ext(r, r, window_table[window_val - 1], d2);
                }
            }
        }
    }
}

#endif // ED25519_DEVICE_CUH