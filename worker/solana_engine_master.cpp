/**
 * ============================================================================
 * PROJECT CODE-NAME: SOLANA_VANITY_MASTER_CORE (AMD HIP PORT)
 * SUBSYSTEM: True Phantom-Compatible Ed25519 Engine
 * ARCHITECTURE: Native SHA-512 Hashing + Native Scalar Multiplication
 * ============================================================================
 */

#include <stdio.h>
#include <stdlib.h>
#include <hip/hip_runtime.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <string.h>
#include <math.h>

#include "ed25519_device.cuh"
#include "sha512.cuh" 

#ifndef DYNAMIC_MODE
#define DYNAMIC_MODE 1 
#endif

#ifndef TARGET_PREFIX_STR
#define TARGET_PREFIX_STR "PUMP"
#define TARGET_SUFFIX_STR "moOn"
#endif

#if DYNAMIC_MODE == 1
    __constant__ char D_TARGET_PREFIX[32];
    __constant__ int  D_TARGET_PREFIX_LEN;
    __constant__ char D_TARGET_SUFFIX[32];
    __constant__ int  D_TARGET_SUFFIX_LEN;
#endif

// =========================================================================
// PREDICTIVE HEURISTIC CACHE RESERVATION (Markov Constants)
// =========================================================================
__constant__ uint64_t D_MARKOV_HEURISTIC_MASK[58];
__constant__ int      D_HEURISTIC_ACTIVE;

void format_commas(uint64_t n, char* out) {
    char temp[64];
    sprintf(temp, "%llu", n);
    int len = strlen(temp);
    int out_idx = 0;
    for (int i = 0; i < len; i++) {
        if (i > 0 && (len - i) % 3 == 0) out[out_idx++] = ',';
        out[out_idx++] = temp[i];
    }
    out[out_idx] = '\0';
}

void format_commas_double(double n, char* out) {
    uint64_t whole = (uint64_t)n;
    double frac = n - whole;
    char temp_whole[64];
    format_commas(whole, temp_whole);
    sprintf(out, "%s.%02u", temp_whole, (unsigned int)(frac * 100));
}

void format_time(double seconds_in, char* out) {
    uint64_t s = (uint64_t)seconds_in;
    uint64_t y = s / 31536000; s %= 31536000;
    uint64_t m = s / 2592000;  s %= 2592000; 
    uint64_t w = s / 604800;   s %= 604800;
    uint64_t d = s / 86400;    s %= 86400;
    uint64_t h = s / 3600;     s %= 3600;
    uint64_t mins = s / 60;    s %= 60;
    
    if (y > 0) sprintf(out, "%lluy %llum %lluw", y, m, w);
    else if (m > 0) sprintf(out, "%llum %lluw %llud", m, w, d);
    else if (d > 0) sprintf(out, "%llud %lluh %llum", d, h, mins);
    else sprintf(out, "%02lluh %02llum %02llus", h, mins, s);
}

void encode_base58(const uint8_t* data, int len, char* out_str) {
    int zeros = 0;
    while (zeros < len && data[zeros] == 0) zeros++;

    uint32_t b58[150] = {0};
    int b58_len = 0;
    
    for (int i = zeros; i < len; i++) {
        uint32_t carry = data[i];
        for (int j = 0; j < b58_len; j++) {
            carry += b58[j] << 8;
            b58[j] = carry % 58;
            carry /= 58;
        }
        while (carry > 0) {
            b58[b58_len++] = carry % 58;
            carry /= 58;
        }
    }

    const char BASE58_ALPHABET[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    int str_idx = 0;
    for (int i = 0; i < zeros; i++) out_str[str_idx++] = '1';
    for (int i = 0; i < b58_len; i++) out_str[str_idx++] = BASE58_ALPHABET[b58[b58_len - 1 - i]];
    out_str[str_idx] = '\0';
}

__global__ void solana_vanity_kernel(fe base_seed, uint64_t *d_found_secret, char *d_found_address, uint8_t *d_found_pubkey, int *d_match_flag) {
    uint64_t global_thread_id = (uint64_t)hipBlockIdx_x * hipBlockDim_x + hipThreadIdx_x;
    
    fe candidate_seed = base_seed;
    uint64_t carry = global_thread_id;
    for (int i = 0; i < 4; i++) {
        uint64_t *limb = (i==0) ? &candidate_seed.l0 : 
                         (i==1) ? &candidate_seed.l1 : 
                         (i==2) ? &candidate_seed.l2 : &candidate_seed.l3;
        uint64_t initial_value = *limb; 
        *limb += carry;
        carry = (*limb < initial_value) ? 1 : 0;
    }

    uint8_t seed_bytes[32];
    uint64_t *seed_limbs = (uint64_t*)seed_bytes;
    seed_limbs[0] = candidate_seed.l0;
    seed_limbs[1] = candidate_seed.l1;
    seed_limbs[2] = candidate_seed.l2;
    seed_limbs[3] = candidate_seed.l3;

    uint8_t expanded_hash[64];
    sha512_32bytes(seed_bytes, expanded_hash);

    uint8_t scalar[32];
    #pragma unroll
    for(int i = 0; i < 32; i++) {
        scalar[i] = expanded_hash[i];
    }
    
    scalar[0] &= 248;
    scalar[31] &= 127;
    scalar[31] |= 64;

    ge_ext new_pub_key;
    ge_scalarmult_base(new_pub_key, scalar);

    fe z_inv, y_affine, x_affine;
    fe_invert(z_inv, new_pub_key.Z);
    fe_mul(y_affine, new_pub_key.Y, z_inv);
    fe_mul(x_affine, new_pub_key.X, z_inv);

    fe_strong_reduce(y_affine);
    fe_strong_reduce(x_affine);

    uint64_t pk_limbs[4] = {y_affine.l0, y_affine.l1, y_affine.l2, y_affine.l3};
    uint64_t x_sign = x_affine.l0 & 1; 
    pk_limbs[3] = (pk_limbs[3] & 0x7FFFFFFFFFFFFFFF) | (x_sign << 63);
    uint8_t* pk_bytes = (uint8_t*)pk_limbs;

    int zeros = 0;
    for (int i = 0; i < 32; i++) {
        if (pk_bytes[i] == 0) zeros++;
        else break;
    }

    uint32_t b58_digits[44] = {0};
    int digit_length = 0;
    
    for (int i = zeros; i < 32; i++) { 
        uint32_t carry_b58 = pk_bytes[i];
        for (int j = 0; j < digit_length; j++) {
            carry_b58 += b58_digits[j] << 8; 
            b58_digits[j] = carry_b58 % 58;  
            carry_b58 /= 58;                 
        }
        while (carry_b58 > 0) {
            b58_digits[digit_length++] = carry_b58 % 58;
            carry_b58 /= 58;
        }
    }
    
    char encoded_buffer[45] = {0}; 
    const char BASE58_ALPHABET[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

    int str_idx = 0;
    for (int i = 0; i < zeros; i++) {
        encoded_buffer[str_idx++] = '1';
    }
    for (int i = 0; i < digit_length; i++) {
        encoded_buffer[str_idx++] = BASE58_ALPHABET[b58_digits[digit_length - 1 - i]];
    }
    encoded_buffer[str_idx] = '\0';

    bool match = true;

    // --- PREDICTIVE HEURISTIC FILTER LAYER ---
    if (D_HEURISTIC_ACTIVE) {
        for (int i = 0; encoded_buffer[i+1] != '\0' && i < 4; i++) {
            int current_idx = b58_char_to_index(encoded_buffer[i]);
            int next_idx    = b58_char_to_index(encoded_buffer[i+1]);
            
            if (current_idx >= 0 && next_idx >= 0) {
                if (!((D_MARKOV_HEURISTIC_MASK[current_idx] >> next_idx) & 1)) {
                    match = false;
                    break;
                }
            }
        }
    }

    // --- STANDARD PREFIX/SUFFIX EXACT MATCH MATCHING ---
    if (match) {
        #if DYNAMIC_MODE == 0
            const int prefix_len = sizeof(TARGET_PREFIX_STR) - 1;
            const int suffix_len = sizeof(TARGET_SUFFIX_STR) - 1;
            
            for (int i = 0; i < prefix_len; i++) {
                if (encoded_buffer[i] != TARGET_PREFIX_STR[i]) { match = false; break; }
            }
            
            if (match && suffix_len > 0) {
                int start_idx = str_idx - suffix_len;
                if (start_idx < prefix_len) {
                    match = false;
                } else {
                    for (int i = 0; i < suffix_len; i++) {
                        if (encoded_buffer[start_idx + i] != TARGET_SUFFIX_STR[i]) {
                            match = false; break;
                        }
                    }
                }
            }
        #else
            for(int i = 0; i < D_TARGET_PREFIX_LEN; i++) {
                if (encoded_buffer[i] != D_TARGET_PREFIX[i]) { match = false; break; }
            }
            
            if (match && D_TARGET_SUFFIX_LEN > 0) {
                int start_idx = str_idx - D_TARGET_SUFFIX_LEN;
                if (start_idx < D_TARGET_PREFIX_LEN) {
                    match = false;
                } else {
                    for(int i = 0; i < D_TARGET_SUFFIX_LEN; i++) {
                        if (encoded_buffer[start_idx + i] != D_TARGET_SUFFIX[i]) {
                            match = false; break;
                        }
                    }
                }
            }
        #endif
    }

    if (match) { 
        // atomicExch maps seamlessly to hipAtomicExch under compiler headers
        if (atomicExch(d_match_flag, 1) == 0) {
            d_found_secret[0] = seed_limbs[0];
            d_found_secret[1] = seed_limbs[1];
            d_found_secret[2] = seed_limbs[2];
            d_found_secret[3] = seed_limbs[3];
            
            for(int i=0; i<32; i++) d_found_pubkey[i] = pk_bytes[i];
            for(int i=0; i<44; i++) d_found_address[i] = encoded_buffer[i];
        }
    }
}

int main(int argc, char **argv) {
    srand(time(NULL));
    fe base_seed = { ((uint64_t)rand() << 32) | rand(), ((uint64_t)rand() << 32) | rand(), ((uint64_t)rand() << 32) | rand(), ((uint64_t)rand() << 32) | rand() };

    int h_match_flag = 0;
    uint64_t h_found_secret[4] = {0};
    uint8_t h_found_pubkey[32] = {0};
    char h_found_address[45] = {0}; 

    int *d_match_flag;
    uint64_t *d_found_secret;
    uint8_t *d_found_pubkey;
    char *d_found_address;

    int threads_per_block = 128;
    int blocks_per_grid = 4096; 
    uint64_t keys_per_loop = (uint64_t)threads_per_block * blocks_per_grid; 

    hipMalloc((void**)&d_match_flag, sizeof(int));
    hipMalloc((void**)&d_found_secret, 4 * sizeof(uint64_t));
    hipMalloc((void**)&d_found_pubkey, 32 * sizeof(uint8_t));
    hipMalloc((void**)&d_found_address, 44 * sizeof(char));

    int total_filter_chars = 0;

    #if DYNAMIC_MODE == 1
        if (argc != 3) {
            printf("[\033[1;31mERROR\033[0m] Invalid params for DYNAMIC_MODE.\n");
            return 1;
        }

        int prefix_len = strlen(argv[1]);
        int suffix_len = strlen(argv[2]);
        total_filter_chars = prefix_len + suffix_len;
        
        hipMemcpyToSymbol(HIP_SYMBOL(D_TARGET_PREFIX), argv[1], prefix_len * sizeof(char));
        hipMemcpyToSymbol(HIP_SYMBOL(D_TARGET_PREFIX_LEN), &prefix_len, sizeof(int));
        
        hipMemcpyToSymbol(HIP_SYMBOL(D_TARGET_SUFFIX), argv[2], suffix_len * sizeof(char));
        hipMemcpyToSymbol(HIP_SYMBOL(D_TARGET_SUFFIX_LEN), &suffix_len, sizeof(int));

        printf("Execution Profile : \033[1;36m[PHANTOM COMPATIBLE / AMD DYNAMIC CACHE]\033[0m\n");
    #else
        total_filter_chars = strlen(TARGET_PREFIX_STR) + strlen(TARGET_SUFFIX_STR);
        printf("Execution Profile : \033[1;33m[PHANTOM COMPATIBLE / AMD HARDCODED SILICON]\033[0m\n");
    #endif

    // --- INITIALIZE MARKOV CONSTANT BOUNDARIES ON HOST ---
    uint64_t h_markov_mask[58];
    for(int i = 0; i < 58; i++) {
        h_markov_mask[i] = ~0ULL; 
    }
    int heuristic_enabled = 0; 

    hipMemcpyToSymbol(HIP_SYMBOL(D_MARKOV_HEURISTIC_MASK), h_markov_mask, 58 * sizeof(uint64_t));
    hipMemcpyToSymbol(HIP_SYMBOL(D_HEURISTIC_ACTIVE), &heuristic_enabled, sizeof(int));

    double geometric_space_base = pow(58.0, total_filter_chars);

    printf("Active Sandbox    : %d-Char Base58 Total Geometric Boundary (%.0f combinations)\n", total_filter_chars, geometric_space_base);
    printf("Output Pipeline   : STDOUT Intercept (No Local Logging)\n");
    printf("------------------------------------------------------------------------\n");

    struct timespec global_start, step_start, step_end;
    clock_gettime(CLOCK_MONOTONIC, &global_start);
    clock_gettime(CLOCK_MONOTONIC, &step_start);

    uint64_t loop_iteration = 0;
    uint64_t last_reported_keys = 0;
    uint32_t update_block_index = 0;

    while (true) { 
        loop_iteration++;
        hipMemset(d_match_flag, 0, sizeof(int));
        
        // Translates original <<<>>> launch geometry into compliant HIP execution streams
        hipLaunchKernelGGL(solana_vanity_kernel, dim3(blocks_per_grid), dim3(threads_per_block), 0, 0, 
                           base_seed, d_found_secret, d_found_address, d_found_pubkey, d_match_flag);
        hipDeviceSynchronize();

        hipMemcpy(&h_match_flag, d_match_flag, sizeof(int), hipMemcpyDeviceToHost);

        if (h_match_flag == 1) {
            hipMemcpy(h_found_secret, d_found_secret, 4 * sizeof(uint64_t), hipMemcpyDeviceToHost);
            hipMemcpy(h_found_address, d_found_address, 44 * sizeof(char), hipMemcpyDeviceToHost);
            hipMemcpy(h_found_pubkey, d_found_pubkey, 32 * sizeof(uint8_t), hipMemcpyDeviceToHost);
            
            uint8_t payload[64];
            uint8_t* secret_bytes = (uint8_t*)h_found_secret;
            
            for (int i = 0; i < 32; i++) {
                payload[i] = secret_bytes[i];
            }
            for (int i = 0; i < 32; i++) {
                payload[32 + i] = h_found_pubkey[i];
            }

            char phantom_priv_key[128];
            encode_base58(payload, 64, phantom_priv_key);
            
            char hex_seed[65];
            for(int i=0; i<32; i++) sprintf(&hex_seed[i*2], "%02X", payload[i]);

            printf("\n========================================================================\n");
            printf(" \033[1;32m[GOLD STRIKE] TARGET MATCH DETECTED IN SILICON ARRAY!\033[0m\n");
            printf("========================================================================\n");
            printf("MATCHED PUBLIC ADDRESS REGISTER : %s\n", h_found_address);
            printf("RAW 256-BIT SEED (HEX)          : 0x%s\n", hex_seed);
            printf("PHANTOM PRIVATE KEY (BASE58)    : %s\n", phantom_priv_key);
            printf("========================================================================\n");
            printf("\033[1;36mNOTE: [SECURITY PATCH] Local file logging disabled. True Zero-Knowledge enforced.\033[0m\n\n");
            
            break;
        }

        uint64_t carry = keys_per_loop;
        uint64_t init_val = base_seed.l0;
        base_seed.l0 += carry;
        carry = (base_seed.l0 < init_val) ? 1 : 0;
        
        init_val = base_seed.l1;
        base_seed.l1 += carry;
        carry = (base_seed.l1 < init_val) ? 1 : 0;

        init_val = base_seed.l2;
        base_seed.l2 += carry;
        carry = (base_seed.l2 < init_val) ? 1 : 0;

        base_seed.l3 += carry;

        clock_gettime(CLOCK_MONOTONIC, &step_end);
        double elapsed_step_seconds = (step_end.tv_sec - step_start.tv_sec) + (step_end.tv_nsec - step_start.tv_nsec) / 1e9;

        if (elapsed_step_seconds >= 1.0) {
            update_block_index++;
            double total_elapsed_run = (step_end.tv_sec - global_start.tv_sec) + (step_end.tv_nsec - global_start.tv_nsec) / 1e9;
            
            uint64_t total_keys_processed = loop_iteration * keys_per_loop;
            uint64_t keys_this_step = total_keys_processed - last_reported_keys;
            
            double current_speed_mhs = (double)keys_this_step / (elapsed_step_seconds * 1e6);
            double current_speed_hz = (double)keys_this_step / elapsed_step_seconds;

            double probability_percent = (1.0 - exp(-(double)total_keys_processed / geometric_space_base)) * 100.0;
            double average_eta_seconds = (current_speed_hz > 0) ? (geometric_space_base / current_speed_hz) : 0;

            char str_elapsed[128], str_eta[128], str_speed[64], str_volume[64];
            format_time(total_elapsed_run, str_elapsed);
            format_time(average_eta_seconds, str_eta);
            format_commas_double(current_speed_mhs, str_speed);
            format_commas(total_keys_processed, str_volume);

            printf("--- [MONITOR UPDATE BLOCK #%u] -----------------------------------------\n", update_block_index);
            printf(" Time.Elapsed.....: %s\n", str_elapsed);
            printf(" Hardware.Status..: True SHA-512 Protocol Active.\n");
            printf(" Speed.Matrix.....: %s Mh/s (Million keys/sec)\n", str_speed);
            printf(" Progress.Volume..: %s total hashes run\n", str_volume);
            printf(" Match.Probability: %.4f%% chance found by now\n", probability_percent);
            printf(" Average.ETA......: %s per valid match\n", str_eta);
            printf("------------------------------------------------------------------------\n");
            
            printf("[TELEMETRY] %llu %.0f %.6f %.2f\n", total_keys_processed, current_speed_hz, probability_percent, average_eta_seconds);
            printf("========================================================================\n\n");

            fflush(stdout);

            last_reported_keys = total_keys_processed;
            clock_gettime(CLOCK_MONOTONIC, &step_start);
        }
    }

    hipFree(d_match_flag);
    hipFree(d_found_secret);
    hipFree(d_found_pubkey);
    hipFree(d_found_address);
    return 0;
}