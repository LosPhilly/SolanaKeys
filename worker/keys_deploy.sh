#!/bin/bash

# Define ANSI color codes for a tactical UI
CYAN='\033[1;36m'
GREEN='\033[1;32m'
ORANGE='\033[1;33m'
RED='\033[1;31m'
NC='\033[0m' # No Color

# =========================================================================
# THE CLEANUP TRAP: Catch Ctrl+C and execute a full teardown
# =========================================================================
cleanup() {
    echo -e "\n\n ${RED}[SYSTEM] Manual override detected (Ctrl+C). Initiating clean shutdown...${NC}"
    echo -e " ${CYAN}   -> Terminating Ephemeral Beacon...${NC}"
    pkill -f ephemeral_beacon.py 2>/dev/null
    echo -e " ${CYAN}   -> Halting Solana Engine...${NC}"
    pkill -f solana_engine 2>/dev/null
    echo -e " ${GREEN}[SYSTEM] Teardown complete. All nodes dark.${NC}"
    exit 0
}

# Bind the cleanup function to the SIGINT (Ctrl+C) and SIGTERM signals
trap cleanup SIGINT SIGTERM

# =========================================================================
# START COMMAND CENTER UI
# =========================================================================
clear
# Ensure any lingering zombies from previous crashes are dead before we start
pkill -f ephemeral_beacon.py 2>/dev/null

echo -e "\033[1;36m   __    _________________\033[0m"
echo -e "\033[1;36m  / /   / ____/ __ \__  /\033[0m"
echo -e "\033[1;36m / /   / __/ / / / // / \033[0m"
echo -e "\033[1;36m/ /___/ /___/ /_/ // /___\033[0m"
echo -e "\033[1;36m/_____/_____/\____/____/\033[0m"
echo -e "\033[1;35m S O L A N A  K E Y v2.0\033[0m"
echo " Running on LeoV1.0 (AMD HIP Node)"
echo "========================================================================"
echo " SOLANA KEY DEPLOYMENT COMMAND CENTER (ED25519 - AMD INTENSITY ARRAY)"
echo "========================================================================"
echo ""
echo " DESCRIPTION:"
echo " This terminal controls the GPU-accelerated ED25519 keyspace engine."
echo " It compiles your target prefix/suffix parameters into the hardware"
echo " pipeline via hipcc and relays the telemetry back to your C2."
echo ""
echo " HOW TO USE:"
echo " 1. Input your desired Case-Sensitive Base58 prefix/suffix."
echo " 2. Select your execution profile (Silicon Bake for raw speed,"
echo "    Dynamic Cache for rapid testing)."
echo " 3. Select your C2 relay node to establish the WSS telemetry beacon."
echo " 4. Leave this terminal open. The engine will run indefinitely, and"
echo "    the beacon will pulse network updates every 120 seconds."
echo ""
echo "========================================================================"

# 1. Capture Target Parameters (Case-Sensitive Base58)
echo -e " ${ORANGE}WARNING: Solana Base58 targets are strictly Case-Sensitive.${NC}"
echo " The characters '0', 'O', 'I', and 'l' are strictly forbidden."
echo "------------------------------------------------------------------------"
read -p " Enter Target Prefix (e.g., PUMP) : " PREFIX_INPUT
read -p " Enter Target Suffix (e.g., moOn, or leave blank) : " SUFFIX_INPUT

# =========================================================================
# --- INJECT VALIDATION GUARDRAIL HERE ---
# =========================================================================
BASE58_REGEX="^[1-9A-HJ-NP-Za-km-z]*$"

if [[ ! "$PREFIX_INPUT" =~ $BASE58_REGEX ]] || [[ ! "$SUFFIX_INPUT" =~ $BASE58_REGEX ]]; then
    echo ""
    echo -e " ${RED}[FATAL ERROR] Invalid Base58 character detected!${NC}"
    echo -e " ${RED}Targets cannot contain '0', 'O', 'I', 'l', or special characters.${NC}"
    echo -e " ${CYAN}Aborting deployment to prevent infinite keyspace loop.${NC}"
    exit 1
fi
# =========================================================================

echo ""
echo -e " ${CYAN}[SYSTEM] Target Mask Loaded:${NC}"
echo -e "  -> Target Prefix : ${ORANGE}${PREFIX_INPUT}${NC}"
echo -e "  -> Target Suffix : ${ORANGE}${SUFFIX_INPUT}${NC}"
echo "------------------------------------------------------------------------"

# 2. Capture Execution Profile
echo " Select Execution Profile:"
echo " [1] HARDCODED SILICON BAKE (Maximum theoretical Mh/s. Triggers recompile)"
echo " [2] DYNAMIC CONSTANT CACHE (Flexible memory routing. Instant launch)"
read -p " Mode Selection (1/2): " MODE_SELECTION
echo "------------------------------------------------------------------------"

# 3. Configure the C2 Relay Connection
echo " Configure C2 Relay Connection:"
echo " [1] Localhost (Discord Bot Relay is running on this exact machine)"
echo " [2] Remote Node (Discord Bot Relay is running on a VPS or separate rig)"
read -p " Relay Location (1/2): " RELAY_SELECTION

if [ "$RELAY_SELECTION" == "2" ]; then
    echo ""
    read -p " Enter Remote Relay IP (e.g., 192.168.1.50): " RELAY_IP
else
    RELAY_IP="127.0.0.1"
fi
echo "========================================================================"

# Auto-spawn the Ephemeral Beacon in the background
echo -e " ${CYAN}[SYSTEM] Spawning Ephemeral Beacon targeting ws://${RELAY_IP}:8765...${NC}"
(sleep 5 && python3 ephemeral_beacon.py $RELAY_IP) &

if [ "$MODE_SELECTION" == "1" ]; then
    echo -e " ${CYAN}[SYSTEM] Compiling strict Base58 strings into AMD hardware paths...${NC}"
    
    # Inject string targets directly into the hipcc compiler stream
    hipcc -O3 \
        -DDYNAMIC_MODE=0 \
        -DTARGET_PREFIX_STR=\"${PREFIX_INPUT}\" \
        -DTARGET_SUFFIX_STR=\"${SUFFIX_INPUT}\" \
        solana_engine_master.cpp -o solana_engine

    echo -e " ${GREEN}[SYSTEM] HIP Build complete. Launching ballistic engine...${NC}"
    echo "========================================================================"
    sleep 1
    
    # Auto-pipe execution into the log for the beacon to read
    ./solana_engine | tee terminal_output.log

elif [ "$MODE_SELECTION" == "2" ]; then
    echo -e " ${CYAN}[SYSTEM] Compiling dynamic AMD routing architecture...${NC}"
    
    # Uses hipcc optimizing for global RDNA/CDNA hardware threads
    hipcc -O3 -DDYNAMIC_MODE=1 solana_engine_master.cpp -o solana_engine
    
    echo -e " ${GREEN}[SYSTEM] HIP Build complete. Launching dynamic engine via CLI arguments...${NC}"
    echo "========================================================================"
    sleep 1
    
    # Auto-pipe execution into the log for the beacon to read
    ./solana_engine "$PREFIX_INPUT" "$SUFFIX_INPUT" | tee terminal_output.log

else
    echo -e " ${RED}[ERROR] Invalid selection. Aborting deployment.${NC}"
    exit 1
fi