"use client";

import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../utils/supabase";
import { Activity, Search, ChevronLeft, ChevronRight, Zap, Lock, Wallet, ArrowRightLeft, ShieldCheck, XCircle } from "lucide-react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import nacl from "tweetnacl";
import util from "tweetnacl-util";

export default function ExchangeView() {
  const [inventory, setInventory] = useState<any[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 9;

  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [processingId, setProcessingId] = useState<string | null>(null);

  const adminWalletEnv = process.env.NEXT_PUBLIC_ADMIN_WALLET;
  if (!adminWalletEnv) {
    console.error("Missing NEXT_PUBLIC_ADMIN_WALLET in .env.local!");
  }
  
  const MERCHANT_WALLET = new PublicKey(
    adminWalletEnv || "11111111111111111111111111111111" 
  );

  useEffect(() => {
    fetchExchangeListings();
  }, []);

  const fetchExchangeListings = async () => {
    setLoadingMarket(true);
    
    const { data, error } = await supabase
      .from('vanity_jobs')
      .select('id, prefix, suffix, result_address, listing_price, customer_wallet')
      .eq('is_listed', true)
      .eq('is_revealed', false); 

    if (data) setInventory(data);
    if (error) console.error("Error fetching exchange:", error);
    setLoadingMarket(false);
  };

  const handleExchangePurchase = async (item: any) => {
    if (!publicKey) {
      alert("Please connect your wallet first to purchase.");
      return;
    }

    if (publicKey.toBase58() === item.customer_wallet) {
        alert("You cannot purchase your own listing. Please cancel the listing instead.");
        return;
    }

    try {
      setProcessingId(item.id);

      const totalLamports = item.listing_price * LAMPORTS_PER_SOL;
      const adminFeeLamports = Math.floor(totalLamports * 0.05); 
      const sellerLamports = totalLamports - adminFeeLamports;

      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(item.customer_wallet),
          lamports: sellerLamports,
        }),
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: MERCHANT_WALLET,
          lamports: adminFeeLamports,
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

      const ephemeralKeyPair = nacl.box.keyPair();
      const clientPubkeyBase64 = util.encodeBase64(ephemeralKeyPair.publicKey);
      const secretKeyBase64 = util.encodeBase64(ephemeralKeyPair.secretKey);

      localStorage.setItem(`solana_keys_secret_${publicKey.toBase58()}`, secretKeyBase64);

      const response = await fetch('/api/exchange/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature,
          buyerWallet: publicKey.toBase58(),
          sellerWallet: item.customer_wallet,
          itemId: item.id,
          priceSol: item.listing_price,
          clientPubkey: clientPubkeyBase64 
        }),
      });

      const result = await response.json();
      
      if (response.ok) {
        alert("P2P Purchase successful! The key has been moved to your Vault.");
        fetchExchangeListings(); 
      } else {
        throw new Error(result.error || "Backend verification failed.");
      }

    } catch (error: any) {
      console.error("Exchange purchase error:", error);
      alert(error.message || "Transaction cancelled or failed.");
    } finally {
      setProcessingId(null);
    }
  };

  // --- NEW: CANCEL LISTING FUNCTION ---
  const handleCancelListing = async (item: any) => {
    if (!publicKey) return;

    try {
      setProcessingId(item.id);

      // Generate a fresh lockbox for the returning item
      const ephemeralKeyPair = nacl.box.keyPair();
      const clientPubkeyBase64 = util.encodeBase64(ephemeralKeyPair.publicKey);
      const secretKeyBase64 = util.encodeBase64(ephemeralKeyPair.secretKey);

      // Save the secret key so the Vault can decrypt it
      localStorage.setItem(`solana_keys_secret_${publicKey.toBase58()}`, secretKeyBase64);

      const response = await fetch('/api/exchange/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: item.id,
          userWallet: publicKey.toBase58(),
          clientPubkey: clientPubkeyBase64
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to cancel listing.");
      }

      alert("Listing cancelled successfully! The key has been securely returned to your Vault.");
      fetchExchangeListings();

    } catch (error: any) {
      console.error("Cancellation error:", error);
      alert(error.message || "Failed to cancel listing.");
    } finally {
      setProcessingId(null);
    }
  };

  const filteredInventory = useMemo(() => {
    return inventory.filter((item: any) => {
      const matchText = (item.prefix || "") + (item.suffix || "");
      return matchText.toLowerCase().includes(searchQuery.toLowerCase());
    });
  }, [searchQuery, inventory]);

  const totalPages = Math.ceil(filteredInventory.length / itemsPerPage);
  const currentInventory = filteredInventory.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);

  const formatTargetPattern = (prefix: string | null, suffix: string | null) => {
    if (prefix && suffix) return `${prefix}...${suffix}`;
    if (prefix) return `${prefix}...`;
    if (suffix) return `...${suffix}`;
    return "Custom";
  };

  const formatAddressPreview = (address: string, prefix: string | null, suffix: string | null) => {
    if (!address) return "";
    const pLen = prefix ? prefix.length : 0;
    const sLen = suffix ? suffix.length : 0;
    
    if (prefix && suffix) {
       return (
        <>
          <span className="text-foreground font-black">{address.substring(0, pLen)}</span>
          <span className="text-zinc-500">...</span>
          <span className="text-foreground font-black">{address.substring(address.length - sLen)}</span>
        </>
      );
    } else if (prefix) {
      return (
        <>
          <span className="text-foreground font-black">{address.substring(0, pLen)}</span>
          <span className="text-zinc-500">{address.substring(pLen, 16)}...</span>
        </>
      );
    } else if (suffix) {
      return (
        <>
          <span className="text-zinc-500">...{address.substring(address.length - 16 - sLen, address.length - sLen)}</span>
          <span className="text-foreground font-black">{address.substring(address.length - sLen)}</span>
        </>
      );
    }
    return <span className="text-zinc-500">{address.substring(0, 16)}...</span>;
  };

  return (
    <div className="space-y-12 animate-in fade-in duration-200">
      
      {/* HERO SECTION */}
      <div className="text-center max-w-3xl mx-auto mt-4 mb-8">
        <h2 className="text-4xl font-black tracking-tight mb-4 text-foreground flex items-center justify-center gap-4">
          <ArrowRightLeft className="text-blue-500" size={36}/> Peer-to-Peer Exchange
        </h2>
        <p className="text-lg text-zinc-500 mb-6">
          Buy and sell unrevealed vanity addresses directly with other users. Smart contracts route the funds, and our Zero-Knowledge Escrow guarantees secure delivery.
        </p>
        <div className="flex justify-center gap-6 text-sm font-bold text-zinc-500">
          <div className="flex items-center gap-2"><ShieldCheck size={16} className="text-blue-500"/> Guaranteed Unrevealed</div>
          <div className="flex items-center gap-2"><Lock size={16} className="text-green-500"/> Trustless Escrow</div>
        </div>
      </div>

      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-xl">
        {/* FILTERS */}
        <div className="flex flex-col md:flex-row justify-between items-center mb-8 gap-4 border-b border-card-border pb-6">
          <div className="relative w-full md:w-96">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <input 
              type="text" 
              placeholder="Search user listings..." 
              value={searchQuery} 
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }} 
              className="w-full bg-input border border-card-border rounded-xl pl-12 pr-4 py-3 text-sm font-bold outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all shadow-inner" 
            />
          </div>
        </div>

        {/* INVENTORY GRID */}
        {loadingMarket ? (
          <div className="py-24 text-center text-zinc-500 font-mono flex flex-col items-center gap-4">
            <Activity className="animate-pulse text-blue-500" size={32} />
            Loading secure escrow...
          </div>
        ) : currentInventory.length === 0 ? (
          <div className="py-24 text-center text-zinc-500 font-bold border border-dashed border-card-border rounded-xl bg-zinc-50 dark:bg-zinc-900/50">
            No addresses found on the exchange.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {currentInventory.map((item, index) => {
              
              const isOwner = publicKey && publicKey.toBase58() === item.customer_wallet;

              return (
                <div key={index} className={`bg-zinc-50 dark:bg-[#0a0a0a] border ${isOwner ? 'border-amber-500/30' : 'border-blue-500/20'} rounded-2xl p-6 transition-all duration-300 hover:shadow-[0_0_15px_rgba(59,130,246,0.15)] group relative overflow-hidden flex flex-col`}>
                  
                  <div className={`absolute top-0 left-0 w-full h-1 ${isOwner ? 'bg-gradient-to-r from-amber-400 to-orange-500' : 'bg-gradient-to-r from-blue-400 to-indigo-500'}`}></div>

                  <div className="flex justify-between items-start mb-6">
                    <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-black uppercase tracking-widest ${isOwner ? 'bg-amber-100 dark:bg-amber-500/10 text-amber-700 dark:text-amber-400' : 'bg-blue-100 dark:bg-blue-500/10 text-blue-700 dark:text-blue-400'}`}>
                      <ArrowRightLeft size={14}/> {isOwner ? 'Your Listing' : 'P2P Listing'}
                    </div>
                  </div>

                  <div className="mb-2">
                    <span className="text-zinc-400 text-xs font-bold uppercase tracking-widest block mb-1">Target Match</span>
                    <h3 className="text-2xl font-black font-mono text-foreground break-all tracking-tight leading-none">
                      {formatTargetPattern(item.prefix, item.suffix)}
                    </h3>
                  </div>

                  {/* Wallet Preview Box */}
                  <div className="bg-white dark:bg-zinc-900 border border-card-border rounded-lg p-3 mb-6 mt-4 flex items-center gap-3 shadow-inner">
                    <Wallet size={16} className="text-zinc-400 shrink-0" />
                    <div className="text-sm font-mono tracking-wide truncate">
                      {formatAddressPreview(item.result_address, item.prefix, item.suffix)}
                    </div>
                  </div>

                  <div className="mt-auto pt-4 border-t border-card-border flex items-center justify-between">
                    <div>
                      <span className="text-zinc-400 text-[10px] font-bold uppercase tracking-widest block">Seller Asking Price</span>
                      <span className="font-black text-lg text-foreground">{item.listing_price} SOL</span>
                    </div>
                    
                    {isOwner ? (
                       <button 
                         onClick={() => handleCancelListing(item)}
                         disabled={processingId === item.id}
                         className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 flex items-center justify-center min-w-[100px] bg-white hover:bg-red-50 dark:bg-zinc-900 dark:hover:bg-red-500/10 text-zinc-500 hover:text-red-500 border border-card-border shadow-sm`}
                       >
                         {processingId === item.id ? <Activity size={16} className="animate-spin" /> : <><XCircle size={14} className="mr-1"/> Cancel</>}
                       </button>
                    ) : (
                       <button 
                         onClick={() => handleExchangePurchase(item)}
                         disabled={processingId === item.id}
                         className={`px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all disabled:opacity-50 disabled:scale-100 active:scale-95 flex items-center justify-center min-w-[100px] bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-md shadow-blue-500/20`}
                       >
                         {processingId === item.id ? <Activity size={16} className="animate-spin" /> : "Buy Now"}
                       </button>
                    )}
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
              Showing {currentInventory.length} of {filteredInventory.length} Listed
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