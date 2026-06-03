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

// =========================================================================
// 2. PRIME FIELD REDUCTION (Modulo 2^255 - 19)
// =========================================================================
__device__ __forceinline__ void fe_reduce(fe &r) {
    // Full PTX reduction — no C/PTX boundary crossing.
    // Extracts bit255 in PTX, multiplies by 19, adds back.
    // Two passes to handle the rare double-overflow case.
    // Using shr+mul+clear+add entirely in PTX prevents the
    // compiler from reordering C reads of r.l3 before PTX
    // register writes are committed under -O3.
    uint64_t over, c;
    asm volatile(
        // Pass 1: extract bit255, clear it, compute c=over*19, add c
        "shr.u64       %4, %3, 63;\n\t"          // over = r.l3 >> 63
        "and.b64       %3, %3, 0x7FFFFFFFFFFFFFFF;\n\t" // r.l3 &= ~bit255
        "mul.lo.u64    %5, %4, 19;\n\t"           // c = over * 19
        "add.cc.u64    %0, %0, %5;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        // Pass 2: same again for double-overflow
        "shr.u64       %4, %3, 63;\n\t"
        "and.b64       %3, %3, 0x7FFFFFFFFFFFFFFF;\n\t"
        "mul.lo.u64    %5, %4, 19;\n\t"
        "add.cc.u64    %0, %0, %5;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        : "+l"(r.l0), "+l"(r.l1), "+l"(r.l2), "+l"(r.l3),
          "=l"(over), "=l"(c)
        :
    );
}

__device__ __forceinline__ void fe_strong_reduce(fe &r) {
    // Test if r >= p by checking if r+19 carries into bit255.
    // If so, r = r+19 with bit255 cleared = r-p.
    // Entirely in PTX to avoid C/PTX register commit hazard.
    uint64_t t0=r.l0, t1=r.l1, t2=r.l2, t3=r.l3;
    uint64_t over;
    asm volatile(
        "add.cc.u64    %0, %0, 19;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        "shr.u64       %4, %3, 63;\n\t"   // over=1 if r+19 wrapped bit255
        : "+l"(t0), "+l"(t1), "+l"(t2), "+l"(t3), "=l"(over)
        :
    );
    if (over) {
        t3 &= 0x7FFFFFFFFFFFFFFF;
        r.l0=t0; r.l1=t1; r.l2=t2; r.l3=t3;
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

// VERIFIED FIX: Safe PTX underflow trap. Correctly subtracts 38 on hardware underflow.
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

__device__ __forceinline__ void fe_mul(fe &r, const fe &a, const fe &b) {
    uint64_t a_arr[4] = {a.l0, a.l1, a.l2, a.l3};
    uint64_t b_arr[4] = {b.l0, b.l1, b.l2, b.l3};
    uint64_t out[8] = {0};

    for (int i = 0; i < 4; i++) {
        uint64_t carry = 0;
        for (int j = 0; j < 4; j++) {
            uint64_t hi = __umul64hi(a_arr[i], b_arr[j]);
            uint64_t lo = a_arr[i] * b_arr[j];
            
            uint64_t sum1_lo = out[i+j] + lo;
            uint64_t carry1 = (sum1_lo < lo) ? 1 : 0;
            
            uint64_t sum2_lo = sum1_lo + carry;
            uint64_t carry2 = (sum2_lo < sum1_lo) ? 1 : 0;
            
            out[i+j] = sum2_lo;
            carry = hi + carry1 + carry2;
        }
        out[i+4] = carry;
    }

    uint64_t carry = 0;
    for (int i = 0; i < 4; i++) {
        uint64_t hi_limb = out[i+4];
        uint64_t hi = __umul64hi(hi_limb, 38);
        uint64_t lo = hi_limb * 38;
        
        uint64_t sum1_lo = out[i] + lo;
        uint64_t carry1 = (sum1_lo < lo) ? 1 : 0;
        
        uint64_t sum2_lo = sum1_lo + carry;
        uint64_t carry2 = (sum2_lo < sum1_lo) ? 1 : 0;
        
        out[i] = sum2_lo;
        carry = hi + carry1 + carry2;
    }

    r.l0 = out[0]; r.l1 = out[1]; r.l2 = out[2]; r.l3 = out[3];
    uint64_t final_fold = carry * 38;
    asm volatile(
        "add.cc.u64    %0, %0, %4;\n\t"
        "addc.cc.u64   %1, %1, 0;\n\t"
        "addc.cc.u64   %2, %2, 0;\n\t"
        "addc.u64      %3, %3, 0;\n\t"
        : "+l"(r.l0), "+l"(r.l1), "+l"(r.l2), "+l"(r.l3) : "l"(final_fold)
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

// VERIFIED FIX: Added d2 parameter and mapped identically to EFD add-2008-hwcd-3
__device__ __forceinline__ void ge_add_ext(ge_ext &r, const ge_ext &p, const ge_ext &q, const fe &d2) {
    fe A, B, C, D, E, F, G, H;
    fe t0, t1;
    
    fe_sub(t0, p.Y, p.X); // Y1 - X1
    fe_sub(t1, q.Y, q.X); // Y2 - X2
    fe_mul(A, t0, t1);    // A = (Y1-X1)*(Y2-X2)
    
    fe_add(t0, p.Y, p.X); // Y1 + X1
    fe_add(t1, q.Y, q.X); // Y2 + X2
    fe_mul(B, t0, t1);    // B = (Y1+X1)*(Y2+X2)
    
    fe_mul(C, p.T, q.T);  // T1 * T2
    fe_mul(C, C, d2);     // C = T1 * 2d * T2
    
    fe_mul(D, p.Z, q.Z);  // Z1 * Z2
    fe_add(D, D, D);      // D = 2 * Z1 * Z2
    
    fe_sub(E, B, A);      // E = B - A
    fe_sub(F, D, C);      // F = D - C
    fe_add(G, D, C);      // G = D + C
    fe_add(H, B, A);      // H = B + A
    
    fe_mul(r.X, E, F);    // X3 = E * F
    fe_mul(r.Y, G, H);    // Y3 = G * H
    fe_mul(r.T, E, H);    // T3 = E * H
    fe_mul(r.Z, F, G);    // Z3 = F * G
}

// VERIFIED FIX: Mapped identically to EFD dbl-2008-hwcd
__device__ __forceinline__ void ge_double(ge_ext &r, const ge_ext &p) {
    fe A, B, C, H, E, G, F;
    fe t0;
    
    fe_sqr(A, p.X); // A = X1^2
    fe_sqr(B, p.Y); // B = Y1^2
    fe_sqr(C, p.Z); fe_add(C, C, C); // C = 2*Z1^2
    fe_add(H, A, B); // H = A + B
    
    fe_add(t0, p.X, p.Y); // X1+Y1
    fe_sqr(t0, t0); // (X1+Y1)^2
    fe_sub(E, H, t0); // E = H - (X1+Y1)^2
    
    fe_sub(G, A, B); // G = A - B
    fe_add(F, C, G); // F = C + G
    
    fe_mul(r.X, E, F); // X3 = E * F
    fe_mul(r.Y, G, H); // Y3 = G * H
    fe_mul(r.T, E, H); // T3 = E * H
    fe_mul(r.Z, F, G); // Z3 = F * G
}

// =========================================================================
// THE MASTER SCALAR MULTIPLICATION (Generating valid Solana Keys)
// =========================================================================
__device__ __forceinline__ void ge_scalarmult_base(ge_ext &r, const uint8_t *scalar) {
    // Dynamic Curve Constant Generation (Eliminates Endianness Bugs)
    fe fe_121665 = {121665, 0, 0, 0};
    fe fe_121666 = {121666, 0, 0, 0};
    fe inv; fe_invert(inv, fe_121666);
    fe d; fe_mul(d, fe_121665, inv);
    fe zero = {0,0,0,0};
    fe_sub(d, zero, d); 
    fe d2; fe_add(d2, d, d); 

    // Dynamic Base Point Assembly
    fe B_x = {0xc9562d608f25d51a, 0x692cc7609525a7b2, 0xc0a4e231fdd6dc5c, 0x216936d3cd6e53fe};
    fe B_y = {0x6666666666666658, 0x6666666666666666, 0x6666666666666666, 0x6666666666666666};
    fe B_z = {1, 0, 0, 0};
    fe B_t; fe_mul(B_t, B_x, B_y); 
    
    ge_ext base = {B_x, B_y, B_z, B_t};
    fe one  = {1,0,0,0};
    
    // Initialize identity point
    r = {zero, one, one, zero}; 

    for (int i = 0; i < 32; i++) {
        uint8_t byte = scalar[i];
        for (int j = 0; j < 8; j++) {
            if ((byte >> j) & 1) {
                ge_add_ext(r, r, base, d2); // d2 successfully passed in
            }
            ge_double(base, base); 
        }
    }
}

#endif // ED25519_DEVICE_CUH