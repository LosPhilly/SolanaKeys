"use client";

import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../utils/supabase";
import { Activity, Search, ChevronLeft, ChevronRight, Crown, Star, Zap, Lock, Wallet } from "lucide-react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import nacl from "tweetnacl";
import util from "tweetnacl-util";
import { sha256 } from "@noble/hashes/sha256";

export default function MarketplaceView() {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTier, setFilterTier] = useState("All");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 9;

  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage } = useWallet();
  const [processingId, setProcessingId] = useState<string | null>(null);

  const adminWalletEnv = process.env.NEXT_PUBLIC_ADMIN_WALLET;
  if (!adminWalletEnv) {
    console.error("Missing NEXT_PUBLIC_ADMIN_WALLET in .env.local!");
  }
  
  const MERCHANT_WALLET = new PublicKey(
    adminWalletEnv || "11111111111111111111111111111111" 
  );

  useEffect(() => {
    fetchMarketplace();
  }, []);

  const fetchMarketplace = async () => {
    setLoadingMarket(true);
    
    const { data, error } = await supabase
      .from('premium_inventory')
      .select('id, pattern_location, matched_pattern, display_address, difficulty_tier, price_sol, status')
      .eq('status', 'AVAILABLE');

    if (data) setInventory(data);
    if (error) console.error("Error fetching marketplace:", error);
    setLoadingMarket(false);
  };

  const handlePurchase = async (item: any) => {
    if (!publicKey || !signMessage) {
      alert("Please connect a wallet that supports message signing to purchase.");
      return;
    }

    try {
      setProcessingId(item.id);

      // 1. STATELESS DETERMINISTIC ENCRYPTION HANDSHAKE
      // Triggered BEFORE payment so no funds are lost if the user cancels the prompt
      const authMessageStr = 
        `[SolanaKeys Official Vault Authentication]\n` +
        `Domain: solanakeys.com\n` +
        `Wallet: ${publicKey.toBase58()}\n` +
        `Purpose: Derive End-to-End Encryption key for secure vault access.\n` +
        `Security Notice: Never sign this message on any domain other than solanakeys.com. If signed elsewhere, malicious software can expose historical secrets.`;

      const messageBytes = new TextEncoder().encode(authMessageStr);
      const signatureBytes = await signMessage(messageBytes);

      const hasher = sha256.create();
      hasher.update(signatureBytes);
      hasher.update(new TextEncoder().encode("SolanaKeys_Internal_App_Pepper_v1"));
      const cleanSeed32 = hasher.digest();

      const ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(cleanSeed32);
      const publicKeyBase64 = util.encodeBase64(ephemeralKeyPair.publicKey);
      
      // 2. ON-CHAIN PAYMENT
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: MERCHANT_WALLET,
          lamports: Math.round(item.price_sol * LAMPORTS_PER_SOL),
        })
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = publicKey;

      const signature = await sendTransaction(transaction, connection);

      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      // 3. SECURE HANDOVER API CALL — include blockhash so server can re-confirm
      const response = await fetch('/api/marketplace/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature,
          blockhash,
          lastValidBlockHeight,
          userWallet: publicKey.toBase58(),
          itemId: item.id,
          clientPubkey: publicKeyBase64,
        }),
      });

      const result = await response.json();
      
      if (response.ok) {
        alert("Purchase successful! The key has been securely encrypted and moved to your Vault.");
        fetchMarketplace(); 
      } else {
        throw new Error(result.error || "Backend verification failed.");
      }

    } catch (error: any) {
      console.error("Purchase error:", error);
      alert(error.message || "Transaction cancelled or failed.");
    } finally {
      setProcessingId(null);
    }
  };

  const filteredInventory = useMemo(() => {
    return inventory.filter((item: any) => {
      const matchesSearch = item.matched_pattern?.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesFilter = filterTier === "All" || item.difficulty_tier?.toLowerCase().includes(filterTier.toLowerCase());
      return matchesSearch && matchesFilter;
    });
  }, [searchQuery, filterTier, inventory]);

  const totalPages = Math.ceil(filteredInventory.length / itemsPerPage);
  const currentInventory = filteredInventory.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const formatAddressPreview = (address: string, pattern: string, location: string) => {
    if (!address || !pattern) return address;
    const pLen = pattern.length;
    
    if (location === 'PREFIX') {
      return (
        <>
          <span className="text-foreground font-black">{address.substring(0, pLen)}</span>
          <span className="text-zinc-500">{address.substring(pLen, 16)}...</span>
        </>
      );
    } else {
      return (
        <>
          <span className="text-zinc-500">...{address.substring(address.length - 16 - pLen, address.length - pLen)}</span>
          <span className="text-foreground font-black">{address.substring(address.length - pLen)}</span>
        </>
      );
    }
  };

  const getTierStyles = (tierString: string) => {
    const base = tierString?.toLowerCase() || '';
    if (base.includes('elite')) {
      return {
        icon: <Crown size={16} className="text-yellow-500" />,
        badgeText: "text-yellow-700 dark:text-yellow-400",
        badgeBg: "bg-yellow-100 dark:bg-yellow-500/10",
        border: "border-yellow-500/30",
        glow: "shadow-[0_0_15px_rgba(234,179,8,0.15)]",
        button: "bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 text-white shadow-md shadow-amber-500/20"
      };
    }
    if (base.includes('premium')) {
      return {
        icon: <Star size={16} className="text-purple-500" />,
        badgeText: "text-purple-700 dark:text-purple-400",
        badgeBg: "bg-purple-100 dark:bg-purple-500/10",
        border: "border-purple-500/30",
        glow: "hover:shadow-[0_0_15px_rgba(168,85,247,0.15)]",
        button: "bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-md shadow-purple-500/20"
      };
    }
    return {
      icon: <Zap size={16} className="text-blue-500" />,
      badgeText: "text-blue-700 dark:text-blue-400",
      badgeBg: "bg-blue-100 dark:bg-blue-500/10",
      border: "border-card-border",
      glow: "hover:shadow-lg",
      button: "bg-foreground text-background hover:bg-zinc-800 dark:hover:bg-zinc-200"
    };
  };

  return (
    <div className="space-y-12 animate-in fade-in duration-200">
      
      {/* HERO SECTION */}
      <div className="text-center max-w-3xl mx-auto mt-4 mb-8">
        <h2 className="text-4xl font-black tracking-tight mb-4 text-foreground">
          Premium <span className="text-transparent bg-clip-text bg-gradient-to-r from-green-500 to-emerald-400">Instant</span> Inventory
        </h2>
        <p className="text-lg text-zinc-500 mb-6">
          Skip the hardware generation queue. Secure highly-coveted, pre-mined addresses with zero wait time. Keys are mathematically sealed to your wallet upon purchase.
        </p>
        <div className="flex justify-center gap-6 text-sm font-bold text-zinc-500">
          <div className="flex items-center gap-2"><Lock size={16} className="text-green-500"/> Zero-Knowledge Handover</div>
          <div className="flex items-center gap-2"><Zap size={16} className="text-amber-500"/> Instant Delivery</div>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-xl">
        {/* FILTERS */}
        <div className="flex flex-col md:flex-row justify-between items-center mb-8 gap-4 border-b border-card-border pb-6">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <input 
              type="text" 
              placeholder="Search inventory (e.g., PUMP)..." 
              value={searchQuery} 
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }} 
              className="w-full bg-input border border-card-border rounded-xl pl-12 pr-4 py-3 text-sm font-bold outline-none focus:border-green-500 focus:ring-2 focus:ring-green-500/20 transition-all shadow-inner" 
            />
          </div>
          <div className="flex items-center gap-3 w-full md:w-auto bg-input border border-card-border rounded-xl px-2 py-1">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-widest ml-2">Tier Filter</span>
            <select 
              value={filterTier} 
              onChange={(e) => { setFilterTier(e.target.value); setCurrentPage(1); }} 
              className="bg-transparent border-none py-2 pr-8 text-sm font-black outline-none cursor-pointer focus:ring-0"
            >
              <option value="All">All Tiers</option>
              <option value="Standard">Standard</option>
              <option value="Premium">Premium</option>
              <option value="Elite">Elite</option>
            </select>
          </div>
        </div>

        {/* INVENTORY GRID */}
        {loadingMarket ? (
          <div className="py-24 text-center text-zinc-500 font-mono flex flex-col items-center gap-4">
            <Activity className="animate-pulse text-green-500" size={32} />
            Loading secure inventory...
          </div>
        ) : currentInventory.length === 0 ? (
          <div className="py-24 text-center text-zinc-500 font-bold border border-dashed border-card-border rounded-xl bg-zinc-50 dark:bg-zinc-900/50">
            No addresses found matching your criteria.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {currentInventory.map((item, index) => {
              const styles = getTierStyles(item.difficulty_tier);
              const cleanTierName = item.difficulty_tier?.split('_')[0] || 'Standard';

              return (
                <div key={index} className={`bg-zinc-50 dark:bg-[#0a0a0a] border ${styles.border} rounded-2xl p-6 transition-all duration-300 ${styles.glow} group relative overflow-hidden flex flex-col`}>
                  
                  {/* Subtle Top Gradient for Elite/Premium */}
                  {(cleanTierName === 'Elite' || cleanTierName === 'Premium') && (
                    <div className={`absolute top-0 left-0 w-full h-1 ${cleanTierName === 'Elite' ? 'bg-gradient-to-r from-yellow-400 to-amber-600' : 'bg-gradient-to-r from-purple-500 to-indigo-500'}`}></div>
                  )}

                  <div className="flex justify-between items-start mb-6">
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-widest ${styles.badgeBg} ${styles.badgeText}`}>
                      {styles.icon} {cleanTierName}
                    </div>
                    <div className="bg-zinc-200 dark:bg-zinc-800 text-zinc-500 text-[10px] font-bold px-2 py-1 rounded uppercase tracking-wider">
                      {item.pattern_location || 'PREFIX'}
                    </div>
                  </div>

                  <div className="mb-2">
                    <span className="text-zinc-400 text-xs font-bold uppercase tracking-widest block mb-1">Target Match</span>
                    <h3 className="text-2xl font-black font-mono text-foreground break-all tracking-tight leading-none">
                      {item.matched_pattern}
                    </h3>
                  </div>

                  {/* Wallet Preview Box */}
                  <div className="bg-white dark:bg-zinc-900 border border-card-border rounded-lg p-3 mb-6 mt-4 flex items-center gap-3 shadow-inner">
                    <Wallet size={16} className="text-zinc-400 shrink-0" />
                    <div className="text-sm font-mono tracking-wide truncate">
                      {formatAddressPreview(item.display_address, item.matched_pattern, item.pattern_location)}
                    </div>
                  </div>

                  <div className="mt-auto pt-4 border-t border-card-border flex items-center justify-between">
                    <div>
                      <span className="text-zinc-400 text-[10px] font-bold uppercase tracking-widest block">Price</span>
                      <span className="font-black text-lg text-foreground">{item.price_sol} SOL</span>
                    </div>
                    
                    <button 
                      onClick={() => handlePurchase(item)}
                      disabled={processingId === item.id}
                      className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 flex items-center justify-center min-w-[100px] ${styles.button}`}
                    >
                      {processingId === item.id ? (
                        <Activity size={16} className="animate-spin" />
                      ) : (
                        "Buy Now"
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* PAGINATION */}
        {totalPages > 1 && (
          <div className="flex flex-col sm:flex-row justify-between items-center mt-10 pt-6 border-t border-card-border gap-4">
            <span className="text-sm text-zinc-500 font-bold uppercase tracking-wider">
              Showing {currentInventory.length} of {filteredInventory.length} Available
            </span>
            <div className="flex gap-2 bg-input border border-card-border rounded-lg p-1">
              <button 
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))} 
                disabled={currentPage === 1} 
                className="p-2 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors cursor-pointer"
              >
                <ChevronLeft size={18} />
              </button>
              <div className="px-4 py-2 text-sm font-black flex items-center text-foreground">
                Page {currentPage} of {totalPages}
              </div>
              <button 
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} 
                disabled={currentPage === totalPages} 
                className="p-2 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-30 transition-colors cursor-pointer"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}