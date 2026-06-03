/**
 * gpu_unit_test.cu — fe_mul and ge_add checkpoint test
 *
 * Compile: nvcc -O3 -arch=sm_86 gpu_unit_test.cu -o gpu_test && ./gpu_test
 */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include <cuda_runtime.h>
#include "sha512.cuh"
#include "ed25519_device.cuh"

__global__ void unit_test_kernel(
    uint64_t* out_mul1,   // fe_mul(Bx, By)
    uint64_t* out_mul2,   // fe_mul(Bx, Bx)
    uint64_t* out_sub1,   // fe_sub(By, Bx)
    uint64_t* out_add1,   // fe_add(By, Bx)
    uint64_t* out_d2,     // d2 constant
    uint64_t* out_ry_add1 // r.Y after identity + base (no doublings)
) {
    fe Bx = {0xc9562d608f25d51a,0x692cc7609525a7b2,0xc0a4e231fdd6dc5c,0x216936d3cd6e53fe};
    fe By = {0x6666666666666658,0x6666666666666666,0x6666666666666666,0x6666666666666666};
    fe zero={0,0,0,0}; fe one={1,0,0,0};

    // Test 1: fe_mul(Bx, By) = Bx*By mod p = Bt
    fe r1; fe_mul(r1, Bx, By);
    out_mul1[0]=r1.l0; out_mul1[1]=r1.l1; out_mul1[2]=r1.l2; out_mul1[3]=r1.l3;

    // Test 2: fe_mul(Bx, Bx) = Bx^2 mod p
    fe r2; fe_mul(r2, Bx, Bx);
    out_mul2[0]=r2.l0; out_mul2[1]=r2.l1; out_mul2[2]=r2.l2; out_mul2[3]=r2.l3;

    // Test 3: fe_sub(By, Bx) = By - Bx mod p
    fe r3; fe_sub(r3, By, Bx);
    out_sub1[0]=r3.l0; out_sub1[1]=r3.l1; out_sub1[2]=r3.l2; out_sub1[3]=r3.l3;

    // Test 4: fe_add(By, Bx) = By + Bx mod p
    fe r4; fe_add(r4, By, Bx);
    out_add1[0]=r4.l0; out_add1[1]=r4.l1; out_add1[2]=r4.l2; out_add1[3]=r4.l3;

    // Test 5: d2 dynamic computation
    fe fe_121665={121665,0,0,0}; fe fe_121666={121666,0,0,0};
    fe inv; fe_invert(inv, fe_121666);
    fe d; fe_mul(d, fe_121665, inv);
    fe_sub(d, zero, d);
    fe d2; fe_add(d2, d, d);
    out_d2[0]=d2.l0; out_d2[1]=d2.l1; out_d2[2]=d2.l2; out_d2[3]=d2.l3;

    // Test 6: identity + base_point (NO doublings — straight base point G)
    fe Bt; fe_mul(Bt, Bx, By);
    ge_ext base = {Bx, By, one, Bt};
    ge_ext r_pt = {zero, one, one, zero}; // identity
    ge_add_ext(r_pt, r_pt, base, d2);
    out_ry_add1[0]=r_pt.Y.l0; out_ry_add1[1]=r_pt.Y.l1;
    out_ry_add1[2]=r_pt.Y.l2; out_ry_add1[3]=r_pt.Y.l3;
}

void check(const char* name, uint64_t* got, uint64_t* exp) {
    uint8_t g[32], e[32];
    for (int i=0;i<4;i++) for (int j=0;j<8;j++) {
        g[i*8+j]=(got[i]>>(j*8))&0xFF;
        e[i*8+j]=(exp[i]>>(j*8))&0xFF;
    }
    printf("[GPU] %s: ", name);
    for(int i=0;i<32;i++) printf("%02x",g[i]); printf("\n");
    printf("[EXP] %s: ", name);
    for(int i=0;i<32;i++) printf("%02x",e[i]); printf("\n");
    printf("%s: %s\n\n", name, memcmp(g,e,32)==0?"PASS":"FAIL");
}

int main() {
    uint64_t *d[6];
    for(int i=0;i<6;i++) cudaMalloc(&d[i],32);

    unit_test_kernel<<<1,1>>>(d[0],d[1],d[2],d[3],d[4],d[5]);
    cudaDeviceSynchronize();

    uint64_t h[6][4];
    for(int i=0;i<6;i++) cudaMemcpy(h[i],d[i],32,cudaMemcpyDeviceToHost);

    printf("\n=== fe_mul / fe_sub / fe_add / ge_add checkpoint test ===\n\n");

    // Expected values (computed by Python)
    // fe_mul(Bx, By) = Bt = base point T coord
    uint64_t exp_bt[4]  = {0x6dde8ab3a5b7dda3,0x20f09f80775152f5,0x66ea4e8e64abe37d,0x67875f0fd78b7665};
    // fe_mul(Bx, Bx) = Bx^2 mod p
    uint64_t exp_bx2[4] = {0x690b8a0f82e81c67,0xebe39c555ccb6a7d,0xc92a232fdb1c32f2,0x39e5a76b6f33fadb};
    // fe_sub(By, Bx) = By - Bx mod p
    uint64_t exp_sub[4] = {0x9d103905d740913e,0xfd399f05d140beb3,0xa5c18434688f8a09,0x44fd2f9298f81267};
    // fe_add(By, Bx) = By + Bx mod p  
    uint64_t exp_add[4] = {0x2fbc93c6f58c3b85,0xcf932dc6fb8c0e19,0x270b4898643d42c2,0x7cf9d3a33d4ba65};
    // d2 = 2*d mod p
    uint64_t exp_d2[4]  = {0xebd69b9426b2f159,0x00e0149a8283b156,0x198e80f2eef3d130,0x2406d9dc56dffce7};
    // identity + G (base point, no doublings): r.Y = 2*By (projective, Z=2)
    // Y3 = G*H = (D+C)*(B+A) = (2*1+0)*(2*By) = 2*2*By = 4*By  but Z3=4 so affine y=By
    // Projective Y3 = 4*By mod p
    uint64_t exp_ry[4]  = {0x9999999999999999,0x9999999999999999,0x9999999999999999,0x1999999999999999};

    check("fe_mul(Bx,By)=Bt", h[0], exp_bt);
    check("fe_mul(Bx,Bx)=Bx2", h[1], exp_bx2);
    check("fe_sub(By,Bx)", h[2], exp_sub);
    check("fe_add(By,Bx)", h[3], exp_add);
    check("d2 constant", h[4], exp_d2);
    check("r.Y after id+G", h[5], exp_ry);

    for(int i=0;i<6;i++) cudaFree(d[i]);
    return 0;
}
