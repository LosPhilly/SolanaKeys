#ifndef ED25519_DEVICE_CUH
#define ED25519_DEVICE_CUH

#include <stdint.h>
#include <hip/hip_runtime.h>

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
    
    // HIP multi-precision built-ins mapping straight to AMD VOP3 carry lines
    unsigned long long carry;
    r.l0 = __builtin_addgco(r.l0, c, &carry);
    r.l1 = __builtin_addgci(r.l1, 0, &carry, carry);
    r.l2 = __builtin_addgci(r.l2, 0, &carry, carry);
    r.l3 = __builtin_addgci(r.l3, 0, &carry, carry);

    uint64_t over2 = r.l3 >> 63;
    r.l3 &= 0x7FFFFFFFFFFFFFFF;
    uint64_t c2 = over2 * 19;

    r.l0 = __builtin_addgco(r.l0, c2, &carry);
    r.l1 = __builtin_addgci(r.l1, 0, &carry, carry);
    r.l2 = __builtin_addgci(r.l2, 0, &carry, carry);
    r.l3 = __builtin_addgci(r.l3, 0, &carry, carry);
}

__device__ __forceinline__ void fe_strong_reduce(fe &r) {
    fe temp = r;
    uint64_t c = 19;
    
    unsigned long long carry;
    temp.l0 = __builtin_addgco(temp.l0, c, &carry);
    temp.l1 = __builtin_addgci(temp.l1, 0, &carry, carry);
    temp.l2 = __builtin_addgci(temp.l2, 0, &carry, carry);
    temp.l3 = __builtin_addgci(temp.l3, 0, &carry, carry);

    if (temp.l3 >> 63) {
        temp.l3 &= 0x7FFFFFFFFFFFFFFF;
        r = temp;
    }
}

// =========================================================================
// 3. HARDWARE INTRINSICS: FIELD ARITHMETIC
// =========================================================================
__device__ __forceinline__ void fe_add(fe &r, const fe &a, const fe &b) {
    unsigned long long carry;
    r.l0 = __builtin_addgco(a.l0, b.l0, &carry);
    r.l1 = __builtin_addgci(a.l1, b.l1, &carry, carry);
    r.l2 = __builtin_addgci(a.l2, b.l2, &carry, carry);
    r.l3 = __builtin_addgci(a.l3, b.l3, &carry, carry);
    fe_reduce(r);
}

// Mapped identically to underflow vectors to handle native AMD borrow bits
__device__ __forceinline__ void fe_sub(fe &r, const fe &a, const fe &b) {
    unsigned long long borrow;
    r.l0 = __builtin_subgco(a.l0, b.l0, &borrow);
    r.l1 = __builtin_subgci(a.l1, b.l1, &borrow, borrow);
    r.l2 = __builtin_subgci(a.l2, b.l2, &borrow, borrow);
    r.l3 = __builtin_subgci(a.l3, b.l3, &borrow, borrow);
    
    uint64_t c = (borrow & 1) * 38;
    unsigned long long adjust_borrow;
    r.l0 = __builtin_subgco(r.l0, c, &adjust_borrow);
    r.l1 = __builtin_subgci(r.l1, 0, &adjust_borrow, adjust_borrow);
    r.l2 = __builtin_subgci(r.l2, 0, &adjust_borrow, adjust_borrow);
    r.l3 = __builtin_subgci(r.l3, 0, &adjust_borrow, adjust_borrow);
    
    fe_reduce(r);
}

__device__ __forceinline__ void fe_mul(fe &r, const fe &a, const fe &b) {
    uint64_t a_arr[4] = {a.l0, a.l1, a.l2, a.l3};
    uint64_t b_arr[4] = {b.l0, b.l1, b.l2, b.l3};
    uint64_t out[8] = {0};

    // Utilizing native AMD compiler optimizations for long-multiplication 64-bit lanes
    for (int i = 0; i < 4; i++) {
        uint64_t carry = 0;
        for (int j = 0; j < 4; j++) {
            // __umul64hi crosses over smoothly on modern ROCm platforms
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
    
    unsigned long long final_carry;
    r.l0 = __builtin_addgco(r.l0, final_fold, &final_carry);
    r.l1 = __builtin_addgci(r.l1, 0, &final_carry, final_carry);
    r.l2 = __builtin_addgci(r.l2, 0, &final_carry, final_carry);
    r.l3 = __builtin_addgci(r.l3, 0, &final_carry, final_carry);
    
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
// 5. RADIX-16 PRECOMPUTATION UTILITY
// =========================================================================
__device__ void populate_window_table(ge_ext *table, ge_ext base, const fe &d2) {
    table[0] = base; 
    for (int i = 1; i < 15; i++) {
        ge_add_ext(table[i], table[i-1], base, d2); 
    }
}

// =========================================================================
// THE MASTER SCALAR MULTIPLICATION (Accelerated 4-Bit Window / Radix-16)
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
    
    ge_ext window_table[15];
    populate_window_table(window_table, base, d2);

    fe one = {1,0,0,0};
    
    r = {zero, one, one, zero}; 
    bool first_addition = true;

    for (int i = 31; i >= 0; i--) {
        uint8_t byte = scalar[i];
        
        // --- 1. Evaluate High Nibble (Bits 4-7) ---
        uint8_t nibble_hi = (byte >> 4) & 0x0F;
        if (!first_addition) {
            ge_double(r, r);
            ge_double(r, r);
            ge_double(r, r);
            ge_double(r, r);
        }
        if (nibble_hi > 0) {
            if (first_addition) {
                r = window_table[nibble_hi - 1];
                first_addition = false;
            } else {
                ge_add_ext(r, r, window_table[nibble_hi - 1], d2);
            }
        }

        // --- 2. Evaluate Low Nibble (Bits 0-3) ---
        uint8_t nibble_lo = byte & 0x0F;
        if (!first_addition) {
            ge_double(r, r);
            ge_double(r, r);
            ge_double(r, r);
            ge_double(r, r);
        }
        if (nibble_lo > 0) {
            if (first_addition) {
                r = window_table[nibble_lo - 1];
                first_addition = false;
            } else {
                ge_add_ext(r, r, window_table[nibble_lo - 1], d2);
            }
        }
    }
}

#endif // ED25519_DEVICE_CUH