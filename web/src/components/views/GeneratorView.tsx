"use client";

import { useState, useMemo } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Zap, Search, Cpu, Shield, ChevronDown, Info, Lock, Flame, CheckCircle2, Wallet, AlertTriangle, ArrowRight, RotateCcw, Clock, DollarSign, Star, TrendingUp, Users, Award } from "lucide-react";
import nacl from "tweetnacl";
import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import util from "tweetnacl-util";

const FAQS = [
  { 
    question: "What is a Solana Vanity Address?", 
    answer: "A vanity address is a custom crypto wallet that starts or ends with characters you choose — like 'KASH...' or '...PUMP'. It works exactly like any normal Solana wallet, but it makes your project instantly recognizable on explorers like Solscan. It's the difference between looking professional and looking random." 
  },
  { 
    question: "Can I cancel and get my money back?", 
    answer: "Yes — no questions asked. If your job is taking longer than expected, cancel anytime from your Vault and receive an automated refund straight to your wallet. Standard cancellations get 98% back (2% covers transaction fees). Jobs running over an hour are pro-rated to cover GPU electricity costs. You're never locked in." 
  },
  { 
    question: "How fast is the GPU cluster?", 
    answer: "Our Nvidia RTX cluster runs over 10.5 billion hash operations per second. A 4-character prefix like 'KASH' is typically found in under 10 seconds. A 5-character address takes around 2 minutes. Compare that to browser-based generators which would take your laptop days — and cook it in the process." 
  },
  { 
    question: "Is my private key safe?", 
    answer: "Your key is encrypted end-to-end before it ever leaves our GPU node, using a cryptographic key derived from your wallet signature — which only you can produce. We never see your private key in plaintext. Once you've saved it, you can permanently delete it from our servers with one click." 
  },
  { 
    question: "What characters can I use?", 
    answer: "Solana uses Base58 encoding. The characters 0 (zero), O (capital o), I (capital i), and l (lowercase L) are excluded from all Solana addresses to prevent visual confusion. Everything else — uppercase, lowercase, and numbers 1–9 — is fair game." 
  },
  { 
    question: "What if my order is over 5 characters?", 
    answer: "5-character orders are handled by our standard cluster in about 2 minutes. For 6+ characters, enable Super Search — a dedicated 24-hour GPU run for 2.50 SOL. This is the only way to generate longer vanity addresses reliably without waiting weeks." 
  }
];

const SOCIAL_PROOF = [
  { handle: "@sol_Shark", text: "Generated 'PUMPxyz...' in 8 seconds. Absolutely insane speed.", stars: 5 },
  { handle: "@Grifter413", text: "Finally my treasury wallet looks professional. Worth every SOL.", stars: 5 },
  { handle: "@degen_trader", text: "Used it for my sniper bot wallet. Everyone on chain knows it's mine now.", stars: 5 },
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

      // 1. STATELESS DETERMINISTIC ENCRYPTION HANDSHAKE
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

      const hasher = sha256.create();
      hasher.update(signatureBytes);
      hasher.update(new TextEncoder().encode("SolanaKeys_Internal_App_Pepper_v1"));
      const cleanSeed32 = hasher.digest();

      const ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(cleanSeed32);
      const publicKeyBase64 = util.encodeBase64(ephemeralKeyPair.publicKey);
      
      // 2. ON-CHAIN PAYMENT EXECUTION
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
        skipPreflight: false,
      });

      await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      // 3. PUSH TO SECURE QUEUE
      const response = await fetch('/api/generator/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature,
          blockhash,
          lastValidBlockHeight,
          userWallet: publicKey.toBase58(),
          prefix: prefixValue || null,
          suffix: suffixValue || null,
          priceSol: difficultyMetrics.numericalPrice,
          clientPubkey: publicKeyBase64,
          isSuperUserMode: isSuperUser,
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
      const msg = error.message || "";
      if (msg.includes("User rejected") || msg.includes("rejected the request")) {
        // Silent — user cancelled Phantom prompt
      } else if (msg.includes("active generation job")) {
        alert(msg);
      } else if (msg.includes("insufficient")) {
        alert("Insufficient SOL balance to cover this generation fee.");
      } else {
        alert(`Generation failed: ${msg || "Unknown error."}`);
      }
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <div className="space-y-20 animate-in fade-in duration-200">
      
      {/* ── HERO ── */}
      <div className="text-center max-w-3xl mx-auto mt-2">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400 text-xs font-black mb-6 uppercase tracking-widest border border-green-500/20">
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse inline-block" /> GPU Cluster Online · 10.5B H/s
        </div>
        <h2 className="text-4xl md:text-6xl font-black tracking-tight mb-5 text-foreground leading-none">
          Your Wallet.<br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 via-blue-500 to-cyan-400">
            Your Brand.
          </span>
        </h2>
        <p className="text-lg text-zinc-500 leading-relaxed max-w-xl mx-auto mb-8">
          Stop looking like a random address. Get a wallet that starts or ends with whatever you want — generated in seconds by our dedicated GPU cluster, not your laptop.
        </p>

        {/* Risk-reversal badges */}
        <div className="flex flex-wrap justify-center gap-3 text-xs font-bold">
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-card-border text-zinc-600 dark:text-zinc-400">
            <RotateCcw size={12} className="text-green-500" /> Cancel Anytime · 98% Back
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-card-border text-zinc-600 dark:text-zinc-400">
            <Clock size={12} className="text-blue-500" /> Most done in &lt; 2 min
          </span>
          <span className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-card-border text-zinc-600 dark:text-zinc-400">
            <Lock size={12} className="text-purple-500" /> End-to-End Encrypted
          </span>
        </div>
      </div>

      {/* ── MAIN GENERATOR CARD ── */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-10 shadow-2xl max-w-4xl mx-auto relative overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-40 bg-purple-500/5 blur-3xl rounded-full pointer-events-none" />

        <div className="mb-8 border-b border-card-border pb-6 relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black tracking-tight flex items-center gap-2">
              <Zap size={22} className="text-purple-500" /> Design Your Address
            </h2>
            <p className="text-sm text-zinc-500 mt-1">Type your prefix, suffix, or both. Preview updates live.</p>
          </div>
          <div className="text-xs font-bold text-zinc-500 bg-zinc-100 dark:bg-zinc-900 px-3 py-1.5 rounded-lg border border-card-border">
            Base58 · Excludes: <span className="text-red-400">0 O I l</span>
          </div>
        </div>

        {/* Input fields */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8 relative z-10">
          <div>
            <label className="block text-sm font-black text-zinc-600 dark:text-zinc-400 mb-2 uppercase tracking-wider">
              Starts With <span className="text-zinc-400 font-normal normal-case tracking-normal">(prefix)</span>
            </label>
            <input 
              type="text" 
              value={prefixValue} 
              onChange={(e) => setPrefixValue(e.target.value.replace(/[^a-km-zn-zA-HJ-NP-Z1-9]/g, ''))}
              placeholder="e.g., KASH" 
              className={`w-full bg-input border rounded-xl px-5 py-4 font-mono text-xl outline-none transition-all tracking-widest shadow-inner ${isLengthInvalid ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20 text-red-500' : 'border-card-border focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20'}`}
              maxLength={10}
            />
          </div>
          <div>
            <label className="block text-sm font-black text-zinc-600 dark:text-zinc-400 mb-2 uppercase tracking-wider">
              Ends With <span className="text-zinc-400 font-normal normal-case tracking-normal">(suffix)</span>
            </label>
            <input 
              type="text" 
              value={suffixValue} 
              onChange={(e) => setSuffixValue(e.target.value.replace(/[^a-km-zn-zA-HJ-NP-Z1-9]/g, ''))}
              placeholder="e.g., BoT" 
              className={`w-full bg-input border rounded-xl px-5 py-4 font-mono text-xl outline-none transition-all tracking-widest shadow-inner ${isLengthInvalid ? 'border-red-500 focus:border-red-500 focus:ring-2 focus:ring-red-500/20 text-red-500' : 'border-card-border focus:border-purple-500 focus:ring-2 focus:ring-purple-500/20'}`}
              maxLength={10}
            />
          </div>
        </div>

        {/* Live Phantom Preview */}
        <div className="mb-8 relative z-10">
          <label className="block text-xs font-black text-zinc-500 uppercase tracking-widest mb-3 text-center">Live Preview</label>
          <div className="max-w-sm mx-auto bg-[#1c1c1e] border border-[#3A3B3E] rounded-2xl p-4 shadow-2xl flex items-center gap-4 hover:scale-[1.02] transition-transform cursor-default">
            <div className="w-12 h-12 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center shadow-inner shrink-0">
              <Wallet size={20} className="text-white opacity-90" />
            </div>
            <div>
              <div className="text-white font-bold text-base mb-0.5">My Wallet</div>
              <div className="text-zinc-400 text-sm font-mono tracking-wide">
                <span className={`font-bold ${prefixValue ? 'text-purple-400' : 'text-zinc-600'}`}>{prefixValue || "PREFIX"}</span>
                <span className="text-zinc-700">{"......"}</span>
                <span className={`font-bold ${suffixValue ? 'text-blue-400' : 'text-zinc-600'}`}>{suffixValue || "SUFFIX"}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Super search warning */}
        {totalChars > 5 && (
          <div className={`mb-8 p-5 border rounded-xl text-sm relative z-10 ${!isSuperUser ? 'bg-red-500/10 border-red-500/30' : 'bg-amber-500/10 border-amber-500/30'}`}>
            <div className="flex gap-3 items-start">
              <AlertTriangle className={`${!isSuperUser ? 'text-red-500' : 'text-amber-500'} shrink-0 mt-0.5`} size={18} />
              <div>
                <p className={`font-black text-sm ${!isSuperUser ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
                  {!isSuperUser ? `Limit Exceeded (${totalChars}/5 chars)` : `Super Search Active — ${totalChars} chars`}
                </p>
                <p className="text-xs mt-1 opacity-80 leading-relaxed text-zinc-600 dark:text-zinc-400">
                  {!isSuperUser 
                    ? "Standard tier is capped at 5 characters. Enable Super Search below for a dedicated 24-hour GPU run." 
                    : "Your job will run on dedicated hardware for up to 24 hours. You can cancel anytime for a pro-rated refund."}
                </p>
                <label className={`flex items-center gap-3 mt-4 p-3 rounded-lg cursor-pointer border select-none ${!isSuperUser ? 'bg-red-500/10 border-red-500/20 hover:bg-red-500/20' : 'bg-zinc-900/40 border-amber-500/20'}`}>
                  <input type="checkbox" checked={isSuperUser} onChange={(e) => setIsSuperUser(e.target.checked)} className="w-4 h-4 rounded accent-purple-500 cursor-pointer" />
                  <span className="text-xs font-black uppercase tracking-wider text-purple-400">Enable Super Search (24h GPU Run) — 2.50 SOL</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Pricing card */}
        <div className={`rounded-xl p-6 mb-8 relative z-10 transition-all duration-300 ${difficultyMetrics.isPremium ? 'bg-gradient-to-br from-purple-900/20 to-blue-900/10 border border-purple-500/30' : 'bg-zinc-50 dark:bg-zinc-900/50 border border-card-border'}`}>
          {difficultyMetrics.isPremium && (
            <div className="flex items-center gap-2 mb-4 text-purple-500 text-xs font-black uppercase tracking-widest">
              <CheckCircle2 size={14} /> Hardware Accelerated Tier
            </div>
          )}
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-1">Cluster Fee</div>
              <div className={`text-4xl font-black tracking-tight ${isLengthInvalid ? 'text-red-500' : difficultyMetrics.isPremium ? 'text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-blue-400' : 'text-foreground'}`}>
                {difficultyMetrics.priceEstimate}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-1">Est. Time</div>
              <div className="text-lg font-black text-foreground">{difficultyMetrics.expectedTime}</div>
            </div>
          </div>

          {/* Refund guarantee — the key selling point */}
          {!isLengthInvalid && totalChars > 0 && (
            <div className="mt-5 pt-5 border-t border-card-border/50 flex items-start gap-3 bg-green-500/5 rounded-lg p-3 border border-green-500/10">
              <RotateCcw size={16} className="text-green-500 shrink-0 mt-0.5" />
              <div>
                <div className="text-xs font-black text-green-600 dark:text-green-400 uppercase tracking-wider">98% Refund Guarantee</div>
                <div className="text-xs text-zinc-500 mt-0.5">Not happy? Cancel anytime from your Vault. Your SOL comes back instantly — no questions, no waiting.</div>
              </div>
            </div>
          )}
        </div>

        {/* CTA Button */}
        <button 
          onClick={handlePushToQueue}
          disabled={(!prefixValue && !suffixValue) || isDeploying || isLengthInvalid}
          className={`relative z-10 w-full font-black uppercase tracking-widest py-5 rounded-xl transition-all duration-200 shadow-xl cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none hover:shadow-2xl active:scale-[0.99]
            ${isLengthInvalid 
              ? 'bg-red-950/40 text-red-500 border border-red-900/50 shadow-none'
              : difficultyMetrics.isPremium 
                ? 'bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 hover:scale-[1.01]' 
                : 'bg-foreground text-background hover:bg-zinc-800 dark:hover:bg-zinc-200 hover:scale-[1.01]'}`}
        >
          {isDeploying 
            ? "🔐 Securing & Deploying to GPU Cluster..." 
            : !connected 
              ? "Connect Wallet to Generate" 
              : isLengthInvalid 
                ? `Blocked: ${totalChars}/5 Characters`
                : `Generate Now — ${difficultyMetrics.priceEstimate}`}
        </button>

        <p className="text-center text-xs text-zinc-500 mt-4 relative z-10">
          Cancel anytime · 98% refund · No lock-in
        </p>
      </div>

      {/* ── WHY IT MATTERS ── */}
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-10">
          <h3 className="text-3xl font-black mb-3">Why Your Wallet Address Matters</h3>
          <p className="text-zinc-500">In a world where trust is built on-chain, your address is your first impression.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-card border border-card-border rounded-2xl p-8 hover:border-purple-500/30 transition-colors group">
            <div className="bg-purple-100 dark:bg-purple-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-5 text-purple-600 dark:text-purple-400 group-hover:scale-110 transition-transform">
              <TrendingUp size={26} />
            </div>
            <h4 className="font-black text-lg mb-2">Instant Credibility</h4>
            <p className="text-sm text-zinc-500 leading-relaxed">When your treasury shows <span className="font-mono text-purple-400 text-xs">DAO...</span> or your bot shows <span className="font-mono text-blue-400 text-xs">SNIPE...</span>, followers recognize it immediately. Verification without verification.</p>
          </div>
          <div className="bg-card border border-card-border rounded-2xl p-8 hover:border-blue-500/30 transition-colors group">
            <div className="bg-blue-100 dark:bg-blue-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-5 text-blue-600 dark:text-blue-400 group-hover:scale-110 transition-transform">
              <Cpu size={26} />
            </div>
            <h4 className="font-black text-lg mb-2">10.5 Billion Keys/sec</h4>
            <p className="text-sm text-zinc-500 leading-relaxed">Your browser can't compete. Our bare-metal Nvidia RTX cluster crunches billions of cryptographic operations per second — finding your address in minutes, not days.</p>
          </div>
          <div className="bg-card border border-card-border rounded-2xl p-8 hover:border-green-500/30 transition-colors group">
            <div className="bg-green-100 dark:bg-green-500/10 w-14 h-14 rounded-xl flex items-center justify-center mb-5 text-green-600 dark:text-green-400 group-hover:scale-110 transition-transform">
              <Shield size={26} />
            </div>
            <h4 className="font-black text-lg mb-2">Zero-Knowledge Delivery</h4>
            <p className="text-sm text-zinc-500 leading-relaxed">Your private key is encrypted with a key only your wallet can produce. We can't read it. Nobody can. Delete it from our servers the moment you've saved it.</p>
          </div>
        </div>
      </div>

      {/* ── REFUND GUARANTEE CALLOUT ── */}
      <div className="max-w-4xl mx-auto">
        <div className="bg-gradient-to-r from-green-900/20 to-emerald-900/10 border border-green-500/20 rounded-2xl p-8 md:p-12 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-green-500/5 blur-3xl rounded-full pointer-events-none" />
          <div className="relative z-10 flex flex-col md:flex-row gap-8 items-center">
            <div className="bg-green-500/10 border border-green-500/20 rounded-2xl p-6 shrink-0 text-center min-w-[140px]">
              <div className="text-5xl font-black text-green-500">98%</div>
              <div className="text-xs font-black text-green-600 dark:text-green-400 uppercase tracking-widest mt-1">Refund Rate</div>
            </div>
            <div>
              <h3 className="text-2xl font-black mb-3 flex items-center gap-2">
                <RotateCcw size={20} className="text-green-500" /> You're Never Locked In
              </h3>
              <p className="text-zinc-500 leading-relaxed mb-4">
                Not satisfied with how long it's taking? Cancel your generation job at any time directly from your Vault dashboard. Your SOL is returned automatically — no support tickets, no waiting, no drama.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="flex items-center gap-2 text-zinc-400">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  Cancel anytime with one click
                </div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  Refund sent automatically on-chain
                </div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  98% back for early cancellation
                </div>
                <div className="flex items-center gap-2 text-zinc-400">
                  <CheckCircle2 size={16} className="text-green-500 shrink-0" />
                  Pro-rated if running over 1 hour
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── SOCIAL PROOF ── */}
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <h3 className="text-2xl font-black mb-2 flex items-center gap-2 justify-center">
            <Users size={22} className="text-purple-500" /> What Traders Are Saying
          </h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {SOCIAL_PROOF.map((r, i) => (
            <div key={i} className="bg-card border border-card-border rounded-xl p-6 hover:border-purple-500/20 transition-colors">
              <div className="flex mb-3">
                {Array.from({ length: r.stars }).map((_, s) => (
                  <Star key={s} size={14} className="text-amber-400 fill-amber-400" />
                ))}
              </div>
              <p className="text-sm text-zinc-500 leading-relaxed mb-4">"{r.text}"</p>
              <div className="text-xs font-black text-purple-400">{r.handle}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── FAQ ── */}
      <div className="max-w-4xl mx-auto pb-8">
        <h3 className="text-3xl font-black text-center mb-10">Questions? Answered.</h3>
        <div className="space-y-3">
          {FAQS.map((faq, index) => (
            <div key={index} className="bg-card border border-card-border rounded-xl overflow-hidden transition-all shadow-sm hover:border-purple-500/20">
              <button 
                onClick={() => setOpenFaq(openFaq === index ? null : index)}
                className="w-full flex justify-between items-center p-6 text-left font-bold hover:bg-zinc-50 dark:hover:bg-zinc-900/50 transition-colors gap-4"
              >
                <span className="text-sm md:text-base">{faq.question}</span>
                <ChevronDown size={18} className={`text-purple-500 shrink-0 transition-transform duration-300 ${openFaq === index ? 'rotate-180' : ''}`} />
              </button>
              {openFaq === index && (
                <div className="px-6 pb-6 text-sm text-zinc-500 leading-relaxed border-t border-card-border/50 pt-4">
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
