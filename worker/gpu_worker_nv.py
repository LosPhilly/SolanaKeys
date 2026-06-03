import os
import time
import subprocess
import re
import random
import base64
import math
import sys
import nacl.public
import nacl.encoding
import nacl.secret
import nacl.utils
from datetime import datetime, timezone
from dotenv import load_dotenv
from supabase import create_client, Client

# =========================================================================
# CREDENTIALS SETUP & KEY VERSIONING
# =========================================================================
if not load_dotenv() and os.path.exists("../.env"):
    load_dotenv("../.env")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")  # Service role bypasses RLS
MASTER_INVENTORY_KEY = os.getenv("MASTER_INVENTORY_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("CRITICAL ERROR: Supabase keys not found. Check your .env file.")

if not MASTER_INVENTORY_KEY:
    print("WARNING: MASTER_INVENTORY_KEY missing. Stock will NOT generate securely.")

# Initialize the Key Dictionary for future-proof rotation
MASTER_KEYS_ENV = os.getenv("MASTER_KEYS", f"v1:{MASTER_INVENTORY_KEY}")
ACTIVE_KEY_VERSION = os.getenv("ACTIVE_MASTER_KEY", "v1")
master_key_dict = dict(item.split(":") for item in MASTER_KEYS_ENV.split(","))

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Local configurations - Mapped directly to your compiled CUDA binary
ENGINE_BINARY = "./solana_engine_nv"

# =========================================================================
# THERMAL GOVERNOR CONSTRAINTS (Hardware Guardrails)
# =========================================================================
THERMAL_THROTTLE_C = 92.0   
THERMAL_CRITICAL_C = 97.0   
STOCK_COOLDOWN_MINUTES = 5 

# =========================================================================
# PHANTOM KEY FORMATTING ENGINE (HEX Seed -> PyNaCl -> 64-byte Base58)
# =========================================================================
BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58encode(b: bytes) -> str:
    if not b: return ""
    num = int.from_bytes(b, 'big')
    encoded = ''
    while num > 0:
        num, mod = divmod(num, 58)
        encoded = BASE58_ALPHABET[mod] + encoded
    pad = 0
    for byte in b:
        if byte == 0:
            pad += 1
        else:
            break
    return (BASE58_ALPHABET[0] * pad) + encoded

def expand_to_phantom_format(hex_seed: str) -> str:
    """
    Converts a raw 32-byte hex seed from the GPU into the standard
    Phantom/Solana 64-byte keypair encoded as Base58.
    Uses the cryptography library (RFC 8032), identical to @solana/web3.js.
    """
    if not hex_seed or hex_seed in ["THERMAL_SHUTDOWN", "CANCELLED"]:
        return hex_seed
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        raw_seed = bytes.fromhex(hex_seed)
        if len(raw_seed) != 32:
            print(f"[-] Seed is {len(raw_seed)} bytes, expected 32.")
            return hex_seed
        private_key = Ed25519PrivateKey.from_private_bytes(raw_seed)
        public_key_bytes = private_key.public_key().public_bytes_raw()
        return b58encode(raw_seed + public_key_bytes)
    except Exception as e:
        print(f"[-] Phantom format expansion failed: {e}")
        return hex_seed

# =========================================================================
# BASE58 COMPLIANT INVENTORY TARGETS
# =========================================================================
STOCK_PATTERNS = {
    "Standard": [
        "PAY", "BUY", "DEX", "SWAP", "FiAT", "CASH", "FEE", "TAX", "BULL", "BEAR",
        "APE", "GEM", "CAT", "BAT", "WAGMi", "pump", "pepe", "doge", "WiF", "BoT",
        "NFT", "DAO", "dao", "web3", "DEV", "node", "RPC", "API", "KEY", "MAC"
    ],
    "Premium": [
        "RiCH", "FLEX", "GOLD", "BANK", "WHALe", "VAULT", "moon", "MooN",
        "FAST", "RUSH", "SAFE", "GEMS", "BURN", "SEND", "MINT", "HODL", "Snipe",
        "CHAD", "CHADS", "ALPHA", "SIGMA", "META", "KING", "LORD", "BOSS",
        "Jito", "Pyth", "Ray", "Toly", "ToLy", "Drip", "SOL", "sol"
    ],
    "Elite": [
        "SoLANA", "solana", "RAYDiUM", "JUPiTER", "TENSOR", "METAPLEX",
        "SECURE", "ASSETS", "PRoFiT", "WEALTH", "CAPiTAL", "HACKER", "SYSTEM",
        "DEViCE", "WALLET", "DEPLOY", "CREATE", "SNiPER", "MARKET", "TRADER",
        "WHALES", "BASED", "SAVAGE", "LEGEND", "GENiUS", "MASTER"
    ]
}

class TextMarkovPredictor:
    def __init__(self):
        self.vowels = set("aeiouAEIOU")
        self.transition_matrix = {
            'V': {'V': 0.13, 'C': 0.87},
            'C': {'V': 0.67, 'C': 0.33}
        }
        
    def _get_state(self, char: str) -> str:
        if not char.isalpha():
            return 'C'
        return 'V' if char.lower() in self.vowels else 'C'

    def predict_next_state_distribution(self, current_text: str) -> dict:
        if not current_text:
            return {'V': 0.43, 'C': 0.57}
            
        last_char = current_text[-1]
        current_state = self._get_state(last_char)
        return self.transition_matrix[current_state]

    def calculate_path_density(self, mask_pattern: str) -> float:
        if not mask_pattern or len(mask_pattern) <= 1:
            return 1.0
            
        p_density = 1.0
        for i in range(len(mask_pattern) - 1):
            curr_is_vowel = mask_pattern[i] in self.vowels
            next_is_vowel = mask_pattern[i+1] in self.vowels
            
            if curr_is_vowel:
                p_density *= 0.13 if next_is_vowel else 0.87
            else:
                p_density *= 0.67 if next_is_vowel else 0.33
        return p_density


def get_gpu_temperature():
    try:
        res = subprocess.check_output(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"], stderr=subprocess.DEVNULL)
        return float(res.decode().strip())
    except Exception:
        return 0.0


def is_valid_base58(text):
    if not text: 
        return True 
    return bool(re.match(r"^[1-9A-HJ-NP-Za-km-z]+$", text))

def fetch_custom_job():
    try:
        response = supabase.table("vanity_jobs") \
            .select("*") \
            .eq("status", "PENDING") \
            .order("created_at", desc=False) \
            .limit(1) \
            .execute()
        return response.data[0] if response.data else None
    except Exception as e:
        print(f"[-] Database poll failed: {e}")
        return None

def claim_job(job_id):
    try:
        response = supabase.table("vanity_jobs") \
            .update({"status": "PROCESSING"}) \
            .eq("id", job_id) \
            .eq("status", "PENDING") \
            .execute()
        return len(response.data) > 0
    except Exception as e:
        print(f"[-] Failed to claim job {job_id}: {e}")
        return False

def run_mining_engine(prefix, suffix, timeout_seconds=None, job_id=None, update_frequency=2, device_id=0):
    safe_prefix = str(prefix) if prefix else "-"
    safe_suffix = str(suffix) if suffix else "-"
    
    combined_target = (safe_prefix + safe_suffix).replace("-", "")
    predictor = TextMarkovPredictor()
    path_density = predictor.calculate_path_density(combined_target)
    
    classical_space = 58 ** len(combined_target) if combined_target else 1
    effective_space = classical_space * path_density

    args = [ENGINE_BINARY, safe_prefix, safe_suffix, str(device_id)]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    
    start_time = time.time()
    last_temp_check = 0.0
    
    final_address = None
    final_seed = None  
    
    current_attempts = 0
    current_hashrate = 0.0
    telemetry_counter = 0 
    gpu_temp = 0.0
    
    last_processed_attempts = 0
    step_start_time = time.time()

    print(f"[*] Engine executing binary on GPU #{device_id} with args: PREFIX='{safe_prefix}' SUFFIX='{safe_suffix}'")
    print(f"[*] Heuristic Contraction Multiplier: {path_density:.6f} | Effective Target Cardinality: {effective_space:.2e}")

    # VERIFIED FIX: Use 'while True' so Python reads the entire output buffer 
    # even if the GPU finds the key and exits in under 1 millisecond.
    while True:
        current_loop_time = time.time()
        
        if current_loop_time - last_temp_check > 5.0:
            gpu_temp = get_gpu_temperature()
            last_temp_check = current_loop_time

        if gpu_temp >= THERMAL_CRITICAL_C:
            print(f"\n[CRITICAL THERMAL TRAP] GPU Temp hit {gpu_temp}°C! Exceeds safety threshold of {THERMAL_CRITICAL_C}°C.")
            print("[*] Terminating process array instantly to protect silicon architecture...")
            process.kill()
            if job_id:
                supabase.table("vanity_jobs").update({"status": "PENDING"}).eq("id", job_id).execute()
            return None, "THERMAL_SHUTDOWN"

        if timeout_seconds and (time.time() - start_time > timeout_seconds):
            print(f"[-] Hardware Timeout Reached ({timeout_seconds}s). Terminating engine.")
            process.kill()
            break
            
        try:
            line = process.stdout.readline()
            if not line:
                if process.poll() is not None:
                    break
                time.sleep(0.001)
                continue
        except Exception:
            continue
            
        address_match = re.search(r"MATCHED PUBLIC ADDRESS REGISTER\s*:\s*([1-9A-HJ-NP-Za-km-z]+)", line)
        # -------------------------------------------------------------
        # BYPASS C++ BASE58 BUG: INTERCEPT RAW HEX INSTEAD OF BASE58
        # -------------------------------------------------------------
        hex_match = re.search(r"RAW 256-BIT SEED \(HEX\)\s*:\s*0x([0-9A-Fa-f]+)", line)
        
        if address_match:
            final_address = address_match.group(1)
        if hex_match:
            final_seed = hex_match.group(1)

        telemetry_match = re.search(r"\[TELEMETRY\]\s+(\d+)\s+([\d.]+)", line)
        if telemetry_match:
            current_attempts = int(telemetry_match.group(1))
            
            now = time.time()
            time_delta = now - step_start_time
            
            if time_delta >= 1.0:
                hashes_shipped = current_attempts - last_processed_attempts
                current_hashrate = hashes_shipped / time_delta
                telemetry_counter += 1
                
                if telemetry_counter % update_frequency == 0:
                    if gpu_temp > 0.0:
                        print(f"[MONITOR] [GPU {device_id}] Max Temp: {gpu_temp:.2f}°C | Hashes: {current_attempts} run | True Speed: {current_hashrate / 1e6:.2f} Mh/s")
                    else:
                        print(f"[MONITOR] [GPU {device_id}] Max Temp: TELEMETRY_WAIT | Hashes: {current_attempts} run | True Speed: {current_hashrate / 1e6:.2f} Mh/s")
                
                if gpu_temp >= THERMAL_THROTTLE_C:
                    sleep_duty = min(0.4, (gpu_temp - THERMAL_THROTTLE_C) * 0.08)
                    print(f"[WARNING] [GPU {device_id}] Heat boundary breached ({gpu_temp:.2f}°C). Throttling engine processing streams.")
                    time.sleep(sleep_duty)

                if job_id:
                    try:
                        supabase.table("worker_telemetry").upsert({
                            "job_id": job_id,
                            "gpu_id": device_id,
                            "local_attempts": current_attempts,
                            "local_hashrate": current_hashrate,
                            "updated_at": datetime.now(timezone.utc).isoformat()
                        }, on_conflict="job_id,gpu_id").execute()

                        if device_id == 0:
                            totals = supabase.table("worker_telemetry").select("local_attempts, local_hashrate").eq("job_id", job_id).execute()
                            if totals.data:
                                total_attempts = sum(item["local_attempts"] for item in totals.data)
                                total_hashrate = sum(item["local_hashrate"] for item in totals.data)
                                true_probability = (1.0 - math.exp(-total_attempts / effective_space)) * 100.0
                                
                                check = supabase.table("vanity_jobs").select("status").eq("id", job_id).execute()
                                if check.data and check.data[0]["status"] in ["FAILED", "REFUNDED"]:
                                    print(f"[!] KILL SWITCH ACTIVATED: User aborted job {job_id}. Terminating array.")
                                    process.kill() 
                                    return None, "CANCELLED"

                                supabase.table("vanity_jobs").update({
                                    "attempts": total_attempts,
                                    "hashrate": total_hashrate,
                                    "probability": round(true_probability, 6)
                                }).eq("id", job_id).execute()

                    except Exception as e:
                        print(f"[!] Failed to sync isolated telemetry: {e}")
                
                last_processed_attempts = current_attempts
                step_start_time = now

    process.stdout.close()
    process.stderr.close()
    process.wait()

    if process.returncode != 0 and final_address is None and not timeout_seconds:
        print(f"[-] Engine exited with error code {process.returncode}")
        
    # Expand RAW HEX to PERFECT 64-bytes BEFORE returning to encryptor
    if final_seed:
        final_seed = expand_to_phantom_format(final_seed)
        
    return final_address, final_seed

def generate_stock_item():
    if not MASTER_INVENTORY_KEY:
        print("[-] Cannot generate stock: MASTER_INVENTORY_KEY is missing from .env")
        return

    device_id = int(os.getenv("GPU_ID", "0"))
    tier = random.choice(list(STOCK_PATTERNS.keys()))
    word = random.choice(STOCK_PATTERNS[tier])
    
    location = random.choice(["PREFIX", "SUFFIX"])
    print(f"[*] Stocking Mode Initiated on GPU #{device_id}. Target: {word} (Tier: {tier}, Type: {location})...")
    
    prices = {"Standard": 0.15, "Premium": 0.45, "Elite": 1.50}
    price = prices[tier]
    
    if location == "PREFIX":
        address, phantom_base58 = run_mining_engine(word, "", timeout_seconds=300, job_id=None, device_id=device_id)
    else:
        address, phantom_base58 = run_mining_engine("", word, timeout_seconds=300, job_id=None, device_id=device_id)
    
    if phantom_base58 == "THERMAL_SHUTDOWN":
        print(f"[*] Thermal protective switch paused GPU #{device_id} stock loop. Cooling down...")
        time.sleep(30)
        return

    if address and phantom_base58 and phantom_base58 != "CANCELLED":
        try:
            active_key_string = master_key_dict.get(ACTIVE_KEY_VERSION)
            if not active_key_string:
                raise ValueError(f"Active Key Version '{ACTIVE_KEY_VERSION}' not found in dictionary.")

            master_key_bytes = base64.b64decode(active_key_string)
            box = nacl.secret.SecretBox(master_key_bytes)
            nonce = nacl.utils.random(nacl.secret.SecretBox.NONCE_SIZE)
            
            encrypted_payload_bytes = box.encrypt(phantom_base58.encode('utf-8'), nonce)
            raw_ciphertext = base64.b64encode(encrypted_payload_bytes).decode('utf-8')
            
            safe_encrypted_stock = f"{ACTIVE_KEY_VERSION}:{raw_ciphertext}"

            supabase.table("premium_inventory").insert({
                "display_address": address,
                "matched_pattern": word,
                "pattern_location": location,
                "difficulty_tier": f"{tier}_{len(word)}",
                "price_sol": price,
                "encrypted_payload": safe_encrypted_stock 
            }).execute()
            
            print(f"[+] SUCCESS: Stocked SECURE wallet: {address} ({location}: {word})")
        except Exception as e:
            print(f"[-] Failed to commit stock item to database: {e}")
        finally:
            phantom_base58 = "WIPED"
    else:
        print(f"[*] Stocking attempt for '{word}' aborted or timed out. Cycling background loop.")

def main_loop():
    device_id = int(os.getenv("GPU_ID", "0"))
    print("========================================================================")
    print(f" 🚀 SolanaKeys Unified GPU Worker Node Online - Locked Target GPU #{device_id}")
    print(f" ⏱️  Stocking Governor set to {STOCK_COOLDOWN_MINUTES} minutes")
    print(f" 🌡️  Thermal Guardrails: Throttle at {THERMAL_THROTTLE_C}°C | Hard Cut at {THERMAL_CRITICAL_C}°C")
    print("========================================================================")
    
    predictor = TextMarkovPredictor()

    while True:
        try:
            job = fetch_custom_job()
            
            if job:
                job_id = job.get("id")
                raw_prefix = job.get("prefix")
                raw_suffix = job.get("suffix")
                client_pubkey_b64 = job.get("client_pubkey")
                
                prefix = str(raw_prefix) if raw_prefix else ""
                suffix = str(raw_suffix) if raw_suffix else ""

                if not is_valid_base58(prefix) or not is_valid_base58(suffix):
                    print(f"[!] FAILED: Job {job_id} contains invalid Base58 characters. Discarding.")
                    supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                    continue

                if prefix:
                    distribution = predictor.predict_next_state_distribution(prefix)
                    if len(prefix) > 4 and distribution.get('C', 0) < 0.10:
                        print(f"[!] PREDICTIVE GOVERNOR: Target '{prefix}' flagged as high-entropy anomaly. Dropping.")
                        supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                        continue

                if claim_job(job_id):
                    print(f"[!] Processing Custom Order {job_id} on GPU #{device_id} | Target: {prefix}...{suffix}")
                    address, phantom_base58 = run_mining_engine(prefix, suffix, timeout_seconds=None, job_id=job_id, device_id=device_id)
                    
                    if phantom_base58 == "THERMAL_SHUTDOWN":
                        print(f"[*] Core cluster GPU #{device_id} safely idled due to thermal spike. Restoring baseline...")
                        time.sleep(20)
                        continue

                    if address and phantom_base58 and phantom_base58 != "CANCELLED":
                        timestamp_now = datetime.now(timezone.utc).isoformat()

                        # SECURITY: Require client pubkey — never store a plaintext key.
                        if not client_pubkey_b64:
                            print(f"[!] SECURITY ABORT: Job {job_id} has no client_pubkey. Marking FAILED.")
                            supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                            phantom_base58 = "WIPED"
                            continue

                        try:
                            # A. SealedBox for the client vault — only the client can decrypt.
                            client_public_key = nacl.public.PublicKey(client_pubkey_b64, encoder=nacl.encoding.Base64Encoder)
                            sealed_box = nacl.public.SealedBox(client_public_key)
                            encrypted_payload_bytes = sealed_box.encrypt(phantom_base58.encode('utf-8'))
                            safe_encrypted_payload = base64.b64encode(encrypted_payload_bytes).decode('utf-8')

                            # B. SecretBox under the master key for potential exchange listing.
                            # Stored so the server can move it to escrow without the client
                            # ever sending the raw key over the wire.
                            active_key_string = master_key_dict.get(ACTIVE_KEY_VERSION)
                            if not active_key_string:
                                raise ValueError(f"Master key version '{ACTIVE_KEY_VERSION}' not found.")
                            master_key_bytes_enc = base64.b64decode(active_key_string)
                            master_box = nacl.secret.SecretBox(master_key_bytes_enc)
                            master_nonce = nacl.utils.random(nacl.secret.SecretBox.NONCE_SIZE)
                            master_encrypted = master_box.encrypt(phantom_base58.encode('utf-8'), master_nonce)
                            # Format: "version:base64(nonce+box)" — matches routePurchase/routeCancle
                            safe_master_payload = f"{ACTIVE_KEY_VERSION}:{base64.b64encode(master_encrypted).decode('utf-8')}"

                        except Exception as e:
                            print(f"[-] Encryption failure on job {job_id}: {e}")
                            supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                            phantom_base58 = "WIPED"
                            continue

                        phantom_base58 = "WIPED"

                        supabase.table("vanity_jobs").update({
                            "status": "COMPLETED",
                            "result_address": address,
                            "result_payload": safe_encrypted_payload,
                            "master_payload": safe_master_payload,
                            "completed_at": timestamp_now
                        }).eq("id", job_id).execute()

                        print(f"[+] Custom Order {job_id} delivered (Client SealedBox + Master SecretBox).")
                        
                    elif phantom_base58 == "CANCELLED":
                        print(f"[*] Job {job_id} was successfully terminated by user.")
                        
                    else:
                        print(f"[-] Execution failed for job {job_id}. Marking status as FAILED.")
                        supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                
            else:
                generate_stock_item()
                
        except Exception as e:
            print(f"[ERROR] Worker loop exception: {e}")
            time.sleep(10)  
            
        time.sleep(random.uniform(2.0, 5.0))

if __name__ == "__main__":
    main_loop()