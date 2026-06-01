"use client";

import { useState, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Zap, Search, Cpu, Shield, ChevronDown, Info, Lock, Flame, CheckCircle2, Wallet, AlertTriangle } from "lucide-react";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";

const FAQS = [
  { question: "What is a Solana Vanity Address?", answer: "A vanity address is a custom cryptocurrency wallet address that starts or ends with specific characters of your choosing, such as 'PUMP...'. It works exactly like a normal Solana wallet but offers recognizable branding for your project, DAO, or personal use." },
  { question: "How is SolanaKeys different from other generators?", answer: "Most vanity generators force your web browser to do the math, which freezes your computer and takes days for complex names. SolanaKeys dispatches your request to a dedicated backend GPU cluster, generating millions of hashes per second without slowing down your machine." },
  { question: "Is it safe to generate my private key here?", answer: "Yes. Our GPU nodes operate in strict isolation. Once your address is found, the private key is securely encrypted and delivered directly to your vault. We provide a 'Delete From Server' button so you can permanently purge the key from our database the moment you save it." },
  { question: "How long does it take to generate?", answer: "Wait times depend exponentially on the length of your request. Standard 1-5 characters take anywhere from seconds to a few minutes. Requests exceeding 5 characters require upgrading to our dedicated 24-Hour Super Search tier." },
  { question: "Are there any restricted characters?", answer: "Yes. Solana uses Base58 encoding. To prevent visual confusion, the characters '0' (zero), 'O' (capital o), 'I' (capital i), and 'l' (lowercase L) are permanently excluded from all Solana addresses." },
  { 
    question: "Can I cancel a generation and get a refund?", 
    answer: "Yes! If a generation is taking longer than expected, you can abort the task at any time directly from your Vault. You will receive an automated, cryptographically secured refund back to your wallet (less a standard 2% network/compute fee). If the job has been running for over an hour, the refund is pro-rated to cover raw GPU electricity costs." 
  }
];

export default function GeneratorView({ onJobQueued }: { onJobQueued: () => void }) {
  const { connection } = useConnection();
  const { connected, publicKey, sendTransaction, signMessage } = useWallet();
  const [prefixValue, setPrefixValue] = useState("");
  const [suffixValue, setSuffixValue] = useState("");
  const [isSuperUser, setIsSuperUser] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const difficultyMetrics = useMemo(() => {
    const totalLength = (prefixValue?.length || 0) + (suffixValue?.length || 0);
    const searchSpace = Math.pow(58, totalLength);

    let tier = "Base Tier";
    let priceEstimate = "0.01 SOL";
    let expectedTime = "< 1 second";
    let numericalPrice = 0.01;
    let isPremium = false;

    if (totalLength > 0) {
      if (isSuperUser) {
        tier = "Super Search Tier";
        priceEstimate = "2.50 SOL";
        expectedTime = "Up to 24 Hours Max";
        numericalPrice = 2.50;
        isPremium = true;
      } else if (totalLength <= 4) { 
        tier = "Base Tier"; priceEstimate = "0.01 SOL"; expectedTime = "< 1 second"; numericalPrice = 0.01; isPremium = false; 
      } else if (totalLength === 5) { 
        tier = "Standard Tier"; priceEstimate = "0.15 SOL"; expectedTime = "~2 minutes"; numericalPrice = 0.15; isPremium = true; 
      } else {
        tier = "Tier Cap Exceeded"; priceEstimate = "Upgrade Required"; expectedTime = "Blocked"; numericalPrice = -1; isPremium = true;
      }
    }
    return { totalLength, searchSpace, tier, priceEstimate, expectedTime, numericalPrice, isPremium };
  }, [prefixValue, suffixValue, isSuperUser]);

  // Clean and enforce character limit properties
  const totalChars = (prefixValue?.length || 0) + (suffixValue?.length || 0);
  const isLengthInvalid = totalChars > 5 && !isSuperUser;

  const handlePushToQueue = async () => {
    if (!prefixValue && !suffixValue) return;
    if (!connected || !publicKey || !signMessage) {
      alert("Please connect a wallet that supports cryptographic message signing!");
      return;
    }

    if (difficultyMetrics.numericalPrice === -1 || isLengthInvalid) {
      alert("This configuration exceeds standard lengths. Please enable 'Super Search' or trim your target characters.");
      return;
    }

    setIsDeploying(true);

    try {
      const adminWalletStr = process.env.NEXT_PUBLIC_ADMIN_WALLET;
      if (!adminWalletStr) throw new Error("Admin wallet address configuration missing");

      // --- STATELESS DETERMINISTIC KEY DERIVATION (HARDENED) ---
      // Strict structural declaration to minimize phishing exposure risks
      const authMessageStr = 
        `[SolanaKeys Official Vault Authentication]\n` +
        `Domain: solanakeys.com\n` +
        `Wallet: ${publicKey.toBase58()}\n` +
        `Purpose: Derive End-to-End Encryption key for secure vault access.\n` +
        `Security Notice: Never sign this message on any domain other than solanakeys.com. If signed elsewhere, malicious software can expose historical secrets.`;

      const messageBytes = new TextEncoder().encode(authMessageStr);
      
      let signatureBytes;
      try {
        signatureBytes = await signMessage(messageBytes);
      } catch (signErr) {
        throw new Error("Handshake signature rejected. Authentication is mandatory to secure your End-to-End Encryption.");
      }

      // Contextual double-salting to isolate seed derivation from third-party scripting environments
      const hasher = sha256.create();
      hasher.update(signatureBytes);
      hasher.update(new TextEncoder().encode("SolanaKeys_Internal_App_Pepper_v1"));
      const cleanSeed32 = hasher.digest();

      const ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(cleanSeed32);
      const publicKeyBase64 = btoa(String.fromCharCode(...ephemeralKeyPair.publicKey));
      // ------------------------------------------------------------------
      
      // On-Chain Transaction Settlement
      const destinationPubkey = new PublicKey(adminWalletStr);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

      const transaction = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: destinationPubkey,
          lamports: Math.round(difficultyMetrics.numericalPrice * LAMPORTS_PER_SOL),
        })
      );

      const signature = await sendTransaction(transaction, connection, {
        skipPreflight: true,
      });

      // Transmit parameters along with our derived base64 vault public lock structure
      const response = await fetch('/api/generator/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature,
          userWallet: publicKey.toBase58(),
          prefix: prefixValue || null,
          suffix: suffixValue || null,
          priceSol: difficultyMetrics.numericalPrice,
          clientPubkey: publicKeyBase64,
          isSuperUserMode: isSuperUser
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to secure backend queue position.");

      setPrefixValue("");
      setSuffixValue("");
      setIsSuperUser(false);
      onJobQueued();

    } catch (error: any) {
      console.error("Deployment exception handled:", error);
      alert(`Transaction status: ${error.message || "Failed execution loop."}`);
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="space-y-16 animate-in fade-in duration-200">
      
      {/* HERO SECTION */}
      <div className="text-center max-w-3xl mx-auto mt-4 mb-12">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-500/10 text-purple-600 dark:text-purple-400 text-xs font-bold mb-6 uppercase tracking-widest border border-purple-500/20 shadow-sm">
          <Flame size={14} className="animate-pulse text-orange-500" /> Live Cluster: 10.5B Hashes/sec
        </div>
        <h2 className="text-4xl md:text-5xl font-black tracking-tight mb-4 text-foreground">
          Dominate the <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-600 to-blue-500">Solana Network</span>
        </h2>
        <p className="text-lg text-zinc-500">
          Generate cryptographically secure, instantly recognizable wallet addresses. Build unshakeable trust for your token, DAO, or infrastructure.
        </p>
      </div>

      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-10 shadow-2xl max-w-4xl mx-auto relative overflow-hidden">
        {/* Subtle background glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-32 bg-purple-500/10 blur-3xl rounded-full pointer-events-none"></div>

        <div className="mb-8 border-b border-card-border pb-6 relative z-10">
          <h2 className="text-2xl font-black tracking-tight flex items-center gap-2">
            <Zap size={24} className="text-purple-500" /> Target Parameters
          </h2>
          <p className="text-sm text-zinc-500 mt-2">Design your address. Complexity dictates hardware requirements.</p>
        </div>

        {/* ZK Encryption Trust Banner */}
        <div className="mb-8 bg-green-500/10 border border-green-500/20 text-green-900 dark:text-green-300 rounded-xl p-5 shadow-sm relative z-10 flex gap-4 items-start">
          <div className="bg-green-500/20 p-2 rounded-full shrink-0">
            <Lock size={20} className="text-green-600 dark:text-green-400" />
          </div>
          <div>
            <h3 className="font-black tracking-widest uppercase text-sm text-green-600 dark:text-green-400 mb-1">Indestructible Signature Authentication</h3>
            <p className="text-sm leading-relaxed opacity-90">
              Secured via stateless wallet signatures. Decryption keys are derived instantly from your live wallet handle and never touch persistent browser storage. Zero tracking. Zero loss risk during wallet-switching.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 relative z-10">
          <div>
            <label className="block text-sm font-bold text-zinc-600 dark:text-zinc-400 mb-2">Starts With (Prefix)</label>
            <input 
              type="text" 
              value={prefixValue} 
              onChange={(e) => setPrefixValue(e.target.value.replace(/[^a-km-zn-zA-HJ-NP-Z1-9]/g, ''))}
              placeholder="e.g., Pump" 
              className={`w-full bg-input border rounded-xl px-5 py-4 font-mono text-lg outline-none transition-all tracking-widest shadow-inner ${isLengthInvalid ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20 text-red-500' : 'border-card-border focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20'}`}
              maxLength={10}
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-zinc-600 dark:text-zinc-400 mb-2">Ends With (Suffix)</label>
            <input 
              type="text" 
              value={suffixValue} 
              onChange={(e) => setSuffixValue(e.target.value.replace(/[^a-km-zn-zA-HJ-NP-Z1-9]/g, ''))}
              placeholder="e.g., BoT" 
              className={`w-full bg-input border rounded-xl px-5 py-4 font-mono text-lg outline-none transition-all tracking-widest shadow-inner ${isLengthInvalid ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20 text-red-500' : 'border-card-border focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20'}`}
              maxLength={10}
            />
          </div>
        </div>

        {/* Base58 Rule Banner - Compact */}
        <div className="mb-6 flex items-center justify-center gap-2 text-xs font-bold text-zinc-500 uppercase tracking-widest relative z-10">
          <Info size={14} /> Base58 Rules: Capital <span className="text-purple-500">L</span> allowed. Excludes: <span className="text-red-400">0, O, I, l</span>.
        </div>

        {/* Dynamic Architectural Guardrail Banner */}
        {totalChars > 5 && (
          <div className={`mb-8 p-4 border rounded-xl text-sm relative z-10 transition-colors duration-300 ${!isSuperUser ? 'bg-red-500/10 border-red-500/30 text-red-900 dark:text-red-300' : 'bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-300'}`}>
            <div className="flex gap-3 items-start">
              <AlertTriangle className={`${!isSuperUser ? 'text-red-500' : 'text-amber-500'} shrink-0 mt-0.5`} size={18} />
              <div>
                <p className="font-bold">
                  {!isSuperUser ? `Generation Blocked: Limit Exceeded (${totalChars}/5 chars)` : `Super Search Active (${totalChars} chars)`}
                </p>
                <p className="text-xs mt-1 opacity-90 leading-relaxed">
                  {!isSuperUser 
                    ? "Standard generation is strictly capped at 5 total characters to protect cloud infrastructure. You must shorten your target or toggle Super Search below." 
                    : "You have unlocked the 24-hour dedicated GPU tier. This will execute an unrestricted deep search."}
                </p>
                
                <label className={`flex items-center gap-3 mt-4 p-3 rounded-lg cursor-pointer transition-all select-none border ${!isSuperUser ? 'bg-red-500/10 border-red-500/20 hover:bg-red-500/20' : 'bg-zinc-900/40 border-amber-500/20 hover:bg-zinc-900/60'}`}>
                  <input 
                    type="checkbox" 
                    checked={isSuperUser} 
                    onChange={(e) => setIsSuperUser(e.target.checked)}
                    className="w-4 h-4 rounded accent-purple-500 cursor-pointer"
                  />
                  <span className="text-xs font-black uppercase tracking-wider text-purple-400">
                    Unlock Super User Tier (Fixed Rate 24h GPU Run) — 2.50 SOL
                  </span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Wallet UI Preview */}
        <div className="mb-10 relative z-10">
          <label className="block text-sm font-bold text-zinc-600 dark:text-zinc-400 mb-3 text-center">Live Phantom Preview</label>
          <div className="max-w-sm mx-auto bg-[#2C2D30] border border-[#3A3B3E] rounded-2xl p-4 shadow-xl flex items-center gap-4 hover:scale-[1.02] transition-transform cursor-default">
            <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center shadow-inner">
               <Wallet size={20} className="text-white opacity-80" />
            </div>
            <div>
              <div className="text-white font-bold text-base mb-0.5">Main Wallet</div>
              <div className="text-zinc-400 text-sm font-mono tracking-wide">
                <span className="text-purple-400 font-bold">{prefixValue || "PREFIX"}</span>
                <span className="text-zinc-600">...</span>
                <span className="text-blue-400 font-bold">{suffixValue || "SUFFIX"}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Dynamic Pricing Box */}
        <div className={`rounded-xl p-6 md:p-8 space-y-5 mb-8 relative z-10 transition-all duration-500 ${difficultyMetrics.isPremium ? 'bg-gradient-to-br from-purple-900/10 to-blue-900/10 border border-purple-500/30 shadow-lg' : 'bg-zinc-100 dark:bg-[#0a0a0a] border border-card-border'}`}>
          
          {difficultyMetrics.isPremium && (
            <div className="flex items-center gap-2 mb-2 text-purple-600 dark:text-purple-400 text-xs font-black uppercase tracking-widest">
              <CheckCircle2 size={14} /> Hardware Accelerated Tier
            </div>
          )}

          <div className="flex justify-between items-end border-b border-card-border/50 pb-4">
            <div>
              <span className="text-zinc-500 dark:text-zinc-400 font-bold text-xs uppercase tracking-widest block mb-1">Execution Profile</span>
              <span className={`font-black text-lg ${isLengthInvalid ? 'text-red-500' : difficultyMetrics.isPremium ? 'text-purple-600 dark:text-purple-400' : 'text-foreground'}`}>{difficultyMetrics.tier}</span>
            </div>
            <div className="text-right">
              <span className="text-zinc-500 dark:text-zinc-400 font-bold text-xs uppercase tracking-widest block mb-1">Compute ETA</span>
              <span className={`font-bold ${isLengthInvalid ? 'text-red-500' : 'text-zinc-700 dark:text-zinc-300'}`}>{difficultyMetrics.expectedTime}</span>
            </div>
          </div>
          
          <div className="flex justify-between items-center pt-2">
            <span className="text-lg font-bold text-zinc-600 dark:text-zinc-300">Cluster Fee</span>
            <span className={`text-3xl font-black tracking-tight ${isLengthInvalid ? 'text-red-500' : difficultyMetrics.isPremium ? 'text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-blue-500' : 'text-foreground'}`}>
              {difficultyMetrics.priceEstimate}
            </span>
          </div>
        </div>

        <button 
          onClick={handlePushToQueue}
          disabled={(!prefixValue && !suffixValue) || isDeploying || isLengthInvalid}
          className={`relative z-10 w-full font-black uppercase tracking-widest py-5 rounded-xl transition-all duration-300 shadow-xl cursor-pointer disabled:cursor-not-allowed disabled:hover:scale-100 disabled:shadow-none hover:scale-[1.01] hover:shadow-2xl active:scale-[0.99]
            ${isLengthInvalid 
              ? 'bg-red-950/40 text-red-500 border border-red-900/50 shadow-none'
              : difficultyMetrics.isPremium 
                ? 'bg-gradient-to-r from-purple-600 to-indigo-600 text-white hover:from-purple-500 hover:to-indigo-500' 
                : 'bg-foreground text-background hover:bg-zinc-800 dark:hover:bg-zinc-200'}`}
        >
          {isDeploying ? "Deploying to GPUs..." : !connected ? "Connect Wallet to Generate" : isLengthInvalid ? `Blocked: ${totalChars}/5 Chars` : `Secure & Generate (${difficultyMetrics.priceEstimate})`}
        </button>
      </div>

      {/* HARDWARE / SALES PITCH GRID */}
      <div className="max-w-6xl mx-auto space-y-12 pt-8">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="bg-card/50 border border-card-border p-8 rounded-2xl shadow-sm hover:shadow-md transition-shadow">
            <div className="bg-purple-100 dark:bg-purple-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-6 text-purple-600 dark:text-purple-400">
              <Search size={28} />
            </div>
            <h3 className="font-black text-lg mb-3">Instant Recognition</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Stop looking like a bot. Use a branded prefix for your NFT drops, sniper bots, or DAO treasury so users instantly recognize your official addresses on Solscan.
            </p>
          </div>
          <div className="bg-card/50 border border-card-border p-8 rounded-2xl shadow-sm hover:shadow-md transition-shadow">
            <div className="bg-blue-100 dark:bg-blue-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-6 text-blue-600 dark:text-blue-400">
              <Cpu size={28} />
            </div>
            <h3 className="font-black text-lg mb-3">Bare-Metal Speed</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Don't fry your laptop. Browser-based generators freeze your computer and take days. We dispatch your job to our dedicated Nvidia RTX cluster to crunch billions of hashes in minutes.
            </p>
          </div>
          <div className="bg-card/50 border border-card-border p-8 rounded-2xl shadow-sm hover:shadow-md transition-shadow">
            <div className="bg-green-100 dark:bg-green-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-6 text-green-600 dark:text-green-400">
              <Shield size={28} />
            </div>
            <h3 className="font-black text-lg mb-3">Deterministic E2EE Vault</h3>
            <p className="text-sm text-zinc-500 leading-relaxed">
              Retrieve your key via our strictly isolated cryptographic pipeline. No storage footprints left in your browser state—keys survive mobile sandbox cache clear events seamlessly.
            </p>
          </div>
        </div>
      </div>

      {/* Accordion FAQs */}
      <div className="max-w-4xl mx-auto pt-16">
        <h3 className="text-3xl font-black text-center mb-10">Frequently Asked Questions</h3>
        <div className="space-y-4">
          {FAQS.map((faq, index) => (
            <div key={index} className="bg-card border border-card-border rounded-xl overflow-hidden transition-all shadow-sm hover:shadow-md">
              <button 
                onClick={() => setOpenFaq(openFaq === index ? null : index)}
                className="w-full flex justify-between items-center p-6 text-left font-bold hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors"
              >
                {faq.question}
                <ChevronDown size={20} className={`text-purple-500 transition-transform duration-300 ${openFaq === index ? 'rotate-180' : ''}`} />
              </button>
              {openFaq === index && (
                <div className="p-6 pt-0 text-sm text-zinc-500 leading-relaxed border-t border-card-border/50 mt-2">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}