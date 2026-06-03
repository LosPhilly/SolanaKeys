const web3 = require("@solana/web3.js");
const bs58 = require("bs58");

// Handle different versions of the bs58 npm package
const b58encode = bs58.encode || (bs58.default && bs58.default.encode);

// 1. Paste your RAW 256-BIT SEED (HEX) here from the C++ terminal output
const hexSeed = "E62E190F304B7B4653FE8B502B41371EFBC27152A84D360E48048E6D6D6FE00C";

// 2. Convert the Hex to bytes and derive the Keypair using the official SDK
const seedBytes = Uint8Array.from(Buffer.from(hexSeed, 'hex'));
const keypair = web3.Keypair.fromSeed(seedBytes);

console.log("\n========================================================================");
console.log("💎 VANITY KEY RECOVERED 💎");
console.log("========================================================================");
console.log("Derived Public Key (Matches GPU?) :", keypair.publicKey.toBase58());

console.log("\n--- OPTION 1: Base58 String ---");
console.log(b58encode(keypair.secretKey));

console.log("\n--- OPTION 2: JSON Byte Array ---");
console.log(`[${keypair.secretKey.toString()}]`);
console.log("\n(You can paste the JSON array directly into Phantom if Base58 fails!)");
console.log("========================================================================");