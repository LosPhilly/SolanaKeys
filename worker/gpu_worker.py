import os
import time
import subprocess
import re
import random
import base64
import math
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
load_dotenv()

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

# Local configurations
ENGINE_BINARY = "./solana_engine_nv"

# =========================================================================
# THERMAL GOVERNOR CONSTRAINTS (Hardware Guardrails)
# =========================================================================
THERMAL_THROTTLE_C = 82.0   # Progressive micro-sleep pacing active above this threshold
THERMAL_CRITICAL_C = 87.0   # Hard cut-off boundary. Destroys sub-processes to prevent damage.
STOCK_COOLDOWN_MINUTES = 1 

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
    """Queries NVIDIA System Management Interface directly for live temperature maps."""
    try:
        res = subprocess.check_output(["nvidia-smi", "--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"])
        return float(res.decode().strip())
    except Exception:
        return 0.0  # Fallback if drivers or environment variables break cleanly


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

def run_mining_engine(prefix, suffix, timeout_seconds=None, job_id=None, update_frequency=10):
    """
    Executes the compiled GPU C++ binary, streams output, and updates live stats.
    
    :param update_frequency: Controls console printing. Only prints once every X telemetry updates.
    """
    safe_prefix = str(prefix) if prefix else ""
    safe_suffix = str(suffix) if suffix else ""
    
    combined_target = safe_prefix + safe_suffix
    predictor = TextMarkovPredictor()
    path_density = predictor.calculate_path_density(combined_target)
    
    classical_space = 58 ** len(combined_target) if combined_target else 1
    effective_space = classical_space * path_density

    args = [ENGINE_BINARY, safe_prefix, safe_suffix]
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    
    start_time = time.time()
    last_report_time = time.time()
    
    final_address = None
    final_seed = None  
    
    current_attempts = 0
    current_hashrate = 0.0
    telemetry_counter = 0  # Counter to track incoming telemetry rows

    print(f"[*] Engine executing binary with args: PREFIX='{safe_prefix}' SUFFIX='{safe_suffix}'")
    print(f"[*] Heuristic Contraction Multiplier: {path_density:.6f} | Effective Target Cardinality: {effective_space:.2e}")

    while True:
        gpu_temp = get_gpu_temperature()

        # --- CRITICAL THERMAL HARD SWITCH ---
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
            
        line = process.stdout.readline()
        
        if not line and process.poll() is not None:
            break
            
        if line:
            address_match = re.search(r"MATCHED PUBLIC ADDRESS REGISTER\s*:\s*([1-9A-HJ-NP-Za-km-z]+)", line)
            key_match = re.search(r"PHANTOM PRIVATE KEY \(BASE58\)\s*:\s*([1-9A-HJ-NP-Za-km-z]+)", line)
            
            if address_match:
                final_address = address_match.group(1)
            if key_match:
                final_seed = key_match.group(1)

            telemetry_match = re.search(r"\[TELEMETRY\]\s+(\d+)\s+([\d.]+)", line)
            
            if telemetry_match:
                current_attempts = int(telemetry_match.group(1))
                current_hashrate = float(telemetry_match.group(2))

            # Telemetry Sync & Thermal Kill Switch (Evaluated every second)
            if time.time() - last_report_time > 1.0:
                telemetry_counter += 1
                
                # --- ACCELERATED CONSOLE GOVERNOR ---
                # Only prints to stdout when the counter hits your configured frequency multiple
                if telemetry_counter % update_frequency == 0:
                    print(f"[MONITOR] Core Temp: {gpu_temp}°C | Progress Volume: {current_attempts} hashes run | Speed: {current_hashrate / 1e6:.2f} Mh/s")
                
                # --- ADAPTIVE COOLING THROTTLE ---
                if gpu_temp >= THERMAL_THROTTLE_C:
                    sleep_duty = min(0.4, (gpu_temp - THERMAL_THROTTLE_C) * 0.08)
                    if telemetry_counter % update_frequency == 0:
                        print(f"[WARNING] Heat boundary breached ({gpu_temp}°C). Thermal Throttle active: pacing engine processing strings.")
                    time.sleep(sleep_duty)

                # Database synchronization still runs quietly every second to keep your UI updated
                if job_id:
                    try:
                        check = supabase.table("vanity_jobs").select("status").eq("id", job_id).execute()
                        
                        if check.data and check.data[0]["status"] in ["FAILED", "REFUNDED"]:
                            print(f"[!] KILL SWITCH ACTIVATED: User aborted job {job_id}. Terminating silicon array.")
                            process.kill() 
                            return None, "CANCELLED"

                        if current_attempts > 0 or current_hashrate > 0:
                            true_probability = (1.0 - math.exp(-current_attempts / effective_space)) * 100.0
                            
                            supabase.table("vanity_jobs").update({
                                "attempts": current_attempts,
                                "hashrate": current_hashrate,
                                "probability": round(true_probability, 6)
                            }).eq("id", job_id).execute()

                    except Exception as e:
                        print(f"[!] Failed to sync with database: {e}")
                
                last_report_time = time.time()

    process.stdout.close()
    process.stderr.close()
    process.wait()

    if process.returncode != 0 and final_address is None and not timeout_seconds:
        print(f"[-] Engine exited with error code {process.returncode}")
        
    return final_address, final_seed

def generate_stock_item():
    if not MASTER_INVENTORY_KEY:
        print("[-] Cannot generate stock: MASTER_INVENTORY_KEY is missing from .env")
        return

    tier = random.choice(list(STOCK_PATTERNS.keys()))
    word = random.choice(STOCK_PATTERNS[tier])
    
    location = random.choice(["PREFIX", "SUFFIX"])
    print(f"[*] Stocking Mode Initiated. Target: {word} (Tier: {tier}, Type: {location})...")
    
    prices = {"Standard": 0.15, "Premium": 0.45, "Elite": 1.50}
    price = prices[tier]
    
    if location == "PREFIX":
        address, hex_seed = run_mining_engine(word, "", timeout_seconds=60, job_id=None)
    else:
        address, hex_seed = run_mining_engine("", word, timeout_seconds=60, job_id=None)
    
    if hex_seed == "THERMAL_SHUTDOWN":
        print("[*] Thermal protective switch paused stock generator loop. Cooling down...")
        time.sleep(30)
        return

    if address and hex_seed and hex_seed != "CANCELLED":
        try:
            # --- KEY VERSIONING ENCRYPTION ---
            active_key_string = master_key_dict.get(ACTIVE_KEY_VERSION)
            if not active_key_string:
                raise ValueError(f"Active Key Version '{ACTIVE_KEY_VERSION}' not found in dictionary.")

            master_key_bytes = base64.b64decode(active_key_string)
            box = nacl.secret.SecretBox(master_key_bytes)
            nonce = nacl.utils.random(nacl.secret.SecretBox.NONCE_SIZE)
            
            encrypted_payload_bytes = box.encrypt(hex_seed.encode('utf-8'), nonce)
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
            hex_seed = "WIPED"
    else:
        print(f"[*] Stocking attempt for '{word}' aborted or timed out. Cycling background loop.")

def main_loop():
    print("========================================================================")
    print(" 🚀 SolanaKeys Unified GPU Worker Node Online (Zk-Encryption Active)")
    print(f" ⏱️  Stocking Governor set to {STOCK_COOLDOWN_MINUTES} minutes")
    print(f" 🌡️  Thermal Guardrails: Throttle at {THERMAL_THROTTLE_C}°C | Hard Cut at {THERMAL_CRITICAL_C}°C")
    print("========================================================================")
    
    last_stock_time = 0 
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
                    print(f"[!] Processing Custom Order {job_id} | Target: {prefix}...{suffix}")
                    address, hex_seed = run_mining_engine(prefix, suffix, timeout_seconds=None, job_id=job_id)
                    
                    if hex_seed == "THERMAL_SHUTDOWN":
                        print("[*] Core cluster safely idled due to thermal spike. Restoring architecture baseline...")
                        time.sleep(20)
                        continue

                    if address and hex_seed and hex_seed != "CANCELLED":
                        timestamp_now = datetime.now(timezone.utc).isoformat()
                        safe_encrypted_payload = hex_seed 
                        
                        if client_pubkey_b64:
                            try:
                                client_public_key = nacl.public.PublicKey(client_pubkey_b64, encoder=nacl.encoding.Base64Encoder)
                                sealed_box = nacl.public.SealedBox(client_public_key)
                                encrypted_payload_bytes = sealed_box.encrypt(hex_seed.encode('utf-8'))
                                safe_encrypted_payload = base64.b64encode(encrypted_payload_bytes).decode('utf-8')
                            except Exception as e:
                                print(f"[-] Encryption failure on job {job_id}: {e}")
                                supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                                continue

                        hex_seed = "WIPED"

                        supabase.table("vanity_jobs").update({
                            "status": "COMPLETED",
                            "result_address": address,
                            "result_payload": safe_encrypted_payload, 
                            "completed_at": timestamp_now
                        }).eq("id", job_id).execute()
                        
                        print(f"[+] Custom Order {job_id} successfully delivered (Encrypted).")
                        
                    elif hex_seed == "CANCELLED":
                        print(f"[*] Job {job_id} was successfully terminated by user.")
                        
                    else:
                        print(f"[-] Execution failed for job {job_id}. Marking status as FAILED.")
                        supabase.table("vanity_jobs").update({"status": "FAILED"}).eq("id", job_id).execute()
                
            else:
                current_time = time.time()
                time_since_last_stock = current_time - last_stock_time
                cooldown_seconds = STOCK_COOLDOWN_MINUTES * 60

                if time_since_last_stock > cooldown_seconds:
                    generate_stock_item()
                    last_stock_time = time.time() 
                
        except Exception as e:
            print(f"[ERROR] Worker loop exception: {e}")
            time.sleep(10)  
            
        time.sleep(3)

if __name__ == "__main__":
    main_loop()