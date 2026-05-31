content = r"""# ✨ SolanaKeys: True Zero-Knowledge Vanity Address Generator 🚀

👋 **Welcome to SolanaKeys!** Let's face it: most vanity address generators force you into a corner. You either have to run a slow JavaScript miner in your browser that freezes your computer for days, *or* you have to trust a centralized server to generate your private keys and just *hope* they don't keep a copy. 

**SolanaKeys solves this using a True Zero-Knowledge (ZK), Hardware-Accelerated pipeline.** 🛡️

We utilize a dedicated Nvidia RTX GPU cluster to crunch billions of hashes via bare-metal C++/CUDA. However, before your private key *ever* leaves the volatile VRAM of our GPUs, it is mathematically sealed using an ephemeral Curve25519 public key generated strictly inside your local browser. 

> 🧠 **The Magic:** Our servers, databases, and administrators **cannot** read your generated private keys. This README breaks down exactly how our End-to-End Encryption (E2EE) architecture works, referencing the exact files and functions in this repository so you can verify our claims yourself!

---

## 🔐 The Cryptographic Pipeline: How It Works

Curious about what happens under the hood? Here is the step-by-step journey of your private key.

### 1️⃣ The Ephemeral Browser Lock (Client-Side) 💻
When you request a vanity address (e.g., prefix `PUMP`), your browser generates a temporary, highly secure cryptographic lockbox. 

In `src/components/views/GeneratorView.tsx` (inside the `handlePushToQueue` function), your browser uses `tweetnacl` to generate an ephemeral Curve25519 keypair:
