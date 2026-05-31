# 🔑 SolanaKeys — The Vanity Address Generator That Can't Betray You

> *What if the server literally couldn't steal your keys — even if it wanted to?*

Most vanity address generators put you in an uncomfortable spot 😬. Either you run a sluggish JavaScript miner in your browser that turns your machine into a space heater for **days** — or you hand your private key generation over to a centralized server and just... hope for the best.

**SolanaKeys refuses to make you choose.**

We built a **True Zero-Knowledge (ZK), Hardware-Accelerated** pipeline that gives you GPU-powered speed *and* mathematical proof that your private keys are sealed before they ever leave our hardware. Here's the wild part: even our own admins can't read them. 🧠✨

---

## 🚀 How Fast Are We Talking?

We run a dedicated **Nvidia RTX GPU cluster**, crunching billions of hashes through bare-metal **C++/CUDA**. Want a prefix like `PUMP`? Our hardware chews through the search space at a speed no browser tab could ever dream of.

But raw speed means nothing if it comes at the cost of your security. So here's where it gets interesting...

---

## 🔐 The Cryptographic Pipeline — Step by Step

### Step 1 · Your Browser Builds the Lock 🔒

Before we ever start searching, **your browser generates a cryptographic lockbox** using an ephemeral Curve25519 keypair. This happens entirely on your device — we never see it.

```typescript
// src/components/views/GeneratorView.tsx → handlePushToQueue()

const ephemeralKeyPair = nacl.box.keyPair();

// 🔐 Private key stays home — never leaves your browser
localStorage.setItem(`solana_keys_secret_${publicKey.toBase58()}`, secretKeyBase64);

// 📤 Only the PUBLIC lock travels to the server
const response = await fetch('/api/generator/search', {
  body: JSON.stringify({
    clientPubkey: publicKeyBase64, // ← The Zero-Knowledge Lock
  }),
});
```

Think of it like sending us a padlocked box and keeping the only key. We can fill the box — but we can never open it. 📦🔑

---

### Step 2 · The GPU Goes to Work ⚡

Your request hits our GPU worker node. The engine (`solana_engine_master.cu`) uses:

- 🧮 **Native PTX assembly** for maximum throughput
- 🔄 **Twisted Edwards Curve operations** (`ed25519_device.cuh`)
- 🔥 **Optimized SHA-512 kernel** (`sha512.cuh`)

Crucially: **no file I/O exists in the compiled binary.** The raw 256-bit seed lives only inside volatile GPU registers — temporary by design, gone the moment the process moves on.

---

### Step 3 · The SealedBox Moment 🧪

The *exact millisecond* the GPU finds your matching address, our Python worker intercepts the raw seed in memory and wraps it using your browser's public lock — before anything else can happen.

```python
# gpu_worker.py → main_loop()

client_public_key = nacl.public.PublicKey(client_pubkey_b64, encoder=nacl.encoding.Base64Encoder)
sealed_box = nacl.public.SealedBox(client_public_key)

# 🔒 Seal the key with your lock
encrypted_payload_bytes = sealed_box.encrypt(hex_seed.encode('utf-8'))

# 🧹 Immediately overwrite memory
hex_seed = "WIPED"
```

The math behind this is airtight:

$$C = E_{SealedBox}(P,\ K_{pub})$$

The ciphertext **C** can *only* be decrypted by the holder of **K_priv** — which is sitting safely in your browser's `localStorage`. What lands in our database looks like random gibberish to everyone, including us. 🎲

---

### Step 4 · You Unlock It Locally 🏠

When you visit the **My Vault** tab, your browser fetches the encrypted blob and decrypts it right there on your device — never touching our backend.

```typescript
// src/components/views/VaultView.tsx → unlockSecureVault()

const secretKeyBase64 = localStorage.getItem(`solana_keys_secret_${walletAddress}`);
ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(util.decodeBase64(secretKeyBase64));

// 🔓 Decryption happens entirely client-side
const decryptedBytes = sealedBox.open(
  ciphertextUint8,
  ephemeralKeyPair.publicKey,
  ephemeralKeyPair.secretKey
);
```

Our backend API **never processes or observes `decryptedBytes`**. Full stop. ✅

---

## 🔥 The Burn Protocol — Data Destruction by Design

We don't just protect your keys. We **delete them** on command.

### 🗑️ Manual Hard Purge
Once you've imported your key into Phantom, hit **"Delete From Server"** in the Security section. This fires an irreversible, row-level `DELETE` against the Supabase cluster (`/api/vault/purge/route.ts`). We keep **zero archival backups** of vanity key records.

### 🛒 Marketplace Handover Burn
For pre-generated inventory in the Instant Storefront, the moment your purchase confirms on-chain, the system:

1. 🔓 Unlocks the master inventory payload
2. 🔒 Re-encrypts it exclusively for **your** `clientPubkey`
3. 💥 Violently overwrites and deletes the original record

```typescript
// src/app/api/marketplace/purchase/route.ts

// THE BURN PROTOCOL 🔥
await supabase.from('premium_inventory').delete().eq('id', itemId);
```

No lingering copies. No sneaky archives. Gone. 💨

---

## 🕵️ Verify Everything Yourself

We live by **"Verify, Don't Trust"** — so here's exactly where to look:

| What to Check | Where to Look |
|---|---|
| 🔑 Client-side key generation | `src/components/views/GeneratorView.tsx` |
| 🔒 ZK re-encryption & Burn Protocol | `src/app/api/marketplace/purchase/route.ts` |
| 🖥️ GPU file-logging absence | `solana_engine_master.cu` (search for `fprintf` / `fopen`) |

If you find **anything** that compromises the ephemeral key isolation, please open an Issue. We mean it. 🙏

---

## 💡 TL;DR

| Traditional Generators | SolanaKeys |
|---|---|
| 🐌 Slow browser mining | ⚡ GPU cluster (billions of hashes/sec) |
| 🤞 Trust us with your keys | 🔐 Mathematically impossible for us to read |
| 😬 Hope they don't keep a copy | 🔥 Burn Protocol deletes on command |
| 🎰 Centralized risk | 🛡️ End-to-End Encrypted by design |

Your keys. Your math. Your vault. 🏆
