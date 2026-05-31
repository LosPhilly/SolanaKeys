"use client";

import dynamic from "next/dynamic";
import { useState, useEffect } from "react";
import { useWallet, useConnection } from "@solana/wallet-adapter-react";
import { LAMPORTS_PER_SOL, Transaction, SystemProgram, PublicKey } from "@solana/web3.js";
import { supabase } from "../../utils/supabase";
import bs58 from "bs58";
import { Activity, Key, Trash2, AlertTriangle, Copy, Check, Eye, EyeOff, Wallet, Zap, Hash, Clock, XCircle, Timer, Percent, Lock, Coins, ShieldCheck, ShoppingCart, ArrowRight, Tags, ArrowRightLeft } from "lucide-react";

import nacl from "tweetnacl";
import util from "tweetnacl-util";
import sealedBox from "tweetnacl-sealedbox-js";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false }
);

const formatTargetPattern = (prefix: string | null, suffix: string | null) => {
  if (prefix && suffix) return `${prefix}...${suffix}`;
  if (prefix) return `${prefix}...`;
  if (suffix) return `...${suffix}`;
  return "Custom";
};

const calculateProbability = (targetLength: number, attempts: number) => {
  if (!targetLength || attempts === undefined) return "0.0000%";
  const searchSpace = Math.pow(58, targetLength);
  const prob = (1.0 - Math.exp(-attempts / searchSpace)) * 100;
  return prob >= 99.9999 ? ">99.9999%" : `${prob.toFixed(4)}%`;
};

const getElapsedTime = (createdAt: string) => {
  if (!createdAt) return "0s";
  const start = new Date(createdAt).getTime();
  const now = Date.now();
  const diffSeconds = Math.max(0, Math.floor((now - start) / 1000));

  if (diffSeconds < 60) return `${diffSeconds}s`;
  const mins = Math.floor(diffSeconds / 60);
  const secs = diffSeconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (hrs < 24) return `${hrs}h ${remainingMins}m`;
  const days = Math.floor(hrs / 24);
  const remainingHrs = hrs % 24;
  return `${days}d ${remainingHrs}h`;
};

export default function VaultView() {
  const { connection } = useConnection();
  const { connected, publicKey, signMessage, sendTransaction } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  
  const [activeJobs, setActiveJobs] = useState<any[]>([]);
  const [completedKeys, setCompletedKeys] = useState<any[]>([]);
  const [queuePositions, setQueuePositions] = useState<Record<string, number>>({});
  
  const [isVaultUnlocked, setIsVaultUnlocked] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [revealKey, setRevealKey] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const [listingJobId, setListingJobId] = useState<string | null>(null);
  const [listingPrice, setListingPrice] = useState<string>("0.15");
  const [isListing, setIsListing] = useState(false);

  useEffect(() => {
    if (connected && publicKey) {
      connection.getBalance(publicKey).then((lamports) => {
        setBalance(lamports / LAMPORTS_PER_SOL);
      }).catch(err => console.error("Failed to fetch balance:", err));
    } else {
      setBalance(null);
    }
  }, [connected, publicKey, connection]);

  useEffect(() => {
    if (connected && publicKey) {
      fetchActiveJobs();

      const channel = supabase
        .channel('live-job-stats')
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'vanity_jobs',
            filter: `customer_wallet=eq.${publicKey.toBase58()}`,
          },
          (payload) => {
            setActiveJobs((currentJobs) => {
              return currentJobs.map((job) =>
                job.id === payload.new.id ? { ...job, ...payload.new } : job
              );
            });

            if (payload.new.status === 'COMPLETED' || payload.new.status === 'FAILED') {
              fetchActiveJobs();
            }
          }
        )
        .subscribe();

      const queueInterval = setInterval(() => {
        setActiveJobs((current) => {
          fetchQueuePositions(current);
          return current;
        });
      }, 10000);

      return () => {
        supabase.removeChannel(channel);
        clearInterval(queueInterval);
      };
    } else {
      setActiveJobs([]);
      setCompletedKeys([]);
      setIsVaultUnlocked(false);
    }
  }, [connected, publicKey]);

  const fetchQueuePositions = async (jobs: any[]) => {
    const pendingJobs = jobs.filter(j => j.status === 'PENDING');
    if (pendingJobs.length === 0) return;

    const positions: Record<string, number> = {};
    for (const job of pendingJobs) {
      const { count, error } = await supabase
        .from('vanity_jobs')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'PENDING')
        .lt('created_at', job.created_at);
        
      if (!error && count !== null) {
        positions[job.id] = count + 1;
      }
    }
    setQueuePositions(prev => ({ ...prev, ...positions }));
  };

  const fetchActiveJobs = async () => {
    if (!publicKey) return;
    const { data, error } = await supabase
      .from('vanity_jobs')
      .select('*')
      .eq('customer_wallet', publicKey.toBase58())
      .in('status', ['PENDING', 'STARTING', 'PROCESSING'])
      .order('created_at', { ascending: false });

    if (!error && data) {
      setActiveJobs(data);
      fetchQueuePositions(data);
    }
  };

  const unlockSecureVault = async () => {
    if (!publicKey || !signMessage) {
      alert("Wallet not connected or does not support message signing.");
      return;
    }
    
    setIsUnlocking(true);
    try {
      const walletAddress = publicKey.toBase58();
      const messageStr = `Authenticate to SolanaKeys.\nAction: FETCH_COMPLETED_KEYS\nWallet: ${walletAddress}`;
      const messageBytes = new TextEncoder().encode(messageStr);

      const signatureBytes = await signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);

      const response = await fetch('/api/vault/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publicKey: walletAddress,
          message: messageStr,
          signature: signatureBase58
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to authenticate vault.");
      }

      const result = await response.json();

      const secretKeyBase64 = localStorage.getItem(`solana_keys_secret_${walletAddress}`);
      let ephemeralKeyPair: nacl.BoxKeyPair | null = null;
      
      if (secretKeyBase64) {
        const secretKeyUint8 = util.decodeBase64(secretKeyBase64);
        ephemeralKeyPair = nacl.box.keyPair.fromSecretKey(secretKeyUint8);
      } else {
        console.warn("NO LOCAL BROWSER KEY FOUND! Keys will remain encrypted.");
      }

      const formattedKeys = result.keys
        .filter((job: any) => !job.is_listed) 
        .map((job: any) => {
          let finalPrivateKey = job.result_payload;
          let decryptionFailed = false;

          if (ephemeralKeyPair && job.result_payload) {
            try {
              const ciphertextUint8 = util.decodeBase64(job.result_payload);
              const decryptedBytes = sealedBox.open(
                ciphertextUint8, 
                ephemeralKeyPair.publicKey, 
                ephemeralKeyPair.secretKey
              );
              
              if (decryptedBytes) {
                finalPrivateKey = util.encodeUTF8(decryptedBytes);
              } else {
                throw new Error("Mathematical rejection");
              }
            } catch (e) {
              console.error(`Decryption failed for job ${job.id}. Key rotation mismatch.`);
              decryptionFailed = true;
            }
          } else {
             decryptionFailed = true;
          }

          return {
            id: job.id,
            publicKey: job.result_address,
            privateKey: decryptionFailed ? `[ENCRYPTED] ${finalPrivateKey}` : finalPrivateKey,
            prefix: job.prefix,
            suffix: job.suffix,
            isRevealed: job.is_revealed || false,
            decryptionFailed,
            created: new Date(job.completed_at || job.created_at).toLocaleString()
          };
        });

      setCompletedKeys(formattedKeys);
      setIsVaultUnlocked(true);

    } catch (error: any) {
      console.error("Vault retrieval error:", error);
      alert(error.message || "Failed to securely pull storage records.");
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleReveal = async (key: any) => {
    if (revealKey === key.id) {
      setRevealKey(null); 
      return;
    }

    if (!key.isRevealed) {
      const confirmed = window.confirm("Warning: Revealing this private key will permanently ban it from being listed on the P2P Exchange. Do you wish to proceed?");
      if (!confirmed) return;

      try {
        const { error } = await (supabase.from('vanity_jobs') as any)
          .update({ is_revealed: true })
          .eq('id', key.id);

        if (error) throw error;

        setCompletedKeys(keys => keys.map(k => k.id === key.id ? { ...k, isRevealed: true } : k));
      } catch (e) {
        console.error("Failed to mark key as revealed:", e);
        alert("Failed to reveal key. Please try again.");
        return;
      }
    }
    
    setRevealKey(key.id);
  };

  const handleSecureCopy = async (key: any, copyId: string) => {
    if (!key.isRevealed) {
      const confirmed = window.confirm("Warning: Copying this private key will permanently ban it from being listed on the P2P Exchange. Do you wish to proceed?");
      if (!confirmed) return;

      try {
        const { error } = await (supabase.from('vanity_jobs') as any)
          .update({ is_revealed: true })
          .eq('id', key.id);

        if (error) throw error;
        setCompletedKeys(keys => keys.map(k => k.id === key.id ? { ...k, isRevealed: true } : k));
      } catch (e) {
        console.error("Failed to secure copy update:", e);
        alert("Network error. Could not copy safely.");
        return;
      }
    }

    copyToClipboard(key.privateKey, copyId);
  };

  const submitListing = async (key: any) => {
    if (!publicKey || !sendTransaction) {
      alert("Wallet not fully connected.");
      return;
    }
    setIsListing(true);

    try {
      const priceNum = parseFloat(listingPrice);
      if (isNaN(priceNum) || priceNum <= 0) {
        throw new Error("Please enter a valid price greater than 0.");
      }

      const adminWalletStr = process.env.NEXT_PUBLIC_ADMIN_WALLET;
      if (!adminWalletStr) {
        throw new Error("Admin wallet not configured. Cannot process listing fee.");
      }

      // 1. Charge the 0.025 SOL listing fee directly through the user's wallet
      const transaction = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(adminWalletStr),
          lamports: 0.025 * LAMPORTS_PER_SOL,
        })
      );

      const {
        context: { slot: minContextSlot },
        value: { blockhash, lastValidBlockHeight }
      } = await connection.getLatestBlockhashAndContext();

      const signature = await sendTransaction(transaction, connection, { minContextSlot });

      // Await network confirmation before sending the payload to the backend
      await connection.confirmTransaction({ blockhash, lastValidBlockHeight, signature });

      // 2. Submit the verified payload to the backend
      const response = await fetch('/api/exchange/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: key.id,
          userWallet: publicKey.toBase58(),
          rawPrivateKey: key.privateKey,
          priceSol: priceNum,
          paymentSignature: signature // Submitting the required hash!
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to list item.");
      }

      alert("Item successfully listed on the P2P Exchange!");
      setCompletedKeys(completedKeys.filter(k => k.id !== key.id)); 
      setListingJobId(null);
    } catch (error: any) {
      console.error(error);
      alert(error.message);
    } finally {
      setIsListing(false);
    }
  };

  const executeKeyPurge = async (id: string) => {
    if (!publicKey || !signMessage) {
      alert("Wallet not connected or does not support message signing.");
      return;
    }

    try {
      const messageStr = `Authenticate to SolanaKeys.\nAction: PURGE\nJob ID: ${id}`;
      const messageBytes = new TextEncoder().encode(messageStr);

      const signatureBytes = await signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);

      const response = await fetch('/api/vault/purge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: id,
          publicKey: publicKey.toBase58(),
          message: messageStr,
          signature: signatureBase58
        })
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Failed to verify signature.");
      }
      
      setCompletedKeys(completedKeys.filter(k => k.id !== id));
      setPendingDelete(null);
      setRevealKey(null);

    } catch (error: any) {
      console.error("Failed to purge key:", error);
      alert(error.message || "Failed to securely delete key. Please try again.");
    }
  };

  const cancelJob = async (id: string) => {
    const warningMessage = 
      "⚠️ WARNING: Are you sure you want to cancel this generation?\n\n" +
      "The SOL used to pay for this computational task is NON-REFUNDABLE and will be permanently lost if you proceed.\n\n" +
      "Click 'OK' to abort and forfeit the fee, or 'Cancel' to let the workers finish.";
      
    if (!window.confirm(warningMessage)) return;

    const { error } = await (supabase.from('vanity_jobs') as any)
      .update({ status: 'FAILED', result_payload: 'CANCELLED_BY_USER' })
      .eq('id', id);

    if (error) {
      console.error("Failed to cancel job:", error);
      alert("Failed to cancel the job. Please try again.");
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);

    const executeCopy = async () => {
      try {
        if (navigator?.clipboard && window?.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          throw new Error("Triggering fallback for local testing environments");
        }
      } catch (err) {
        const textArea = document.createElement("textarea");
        textArea.value = text;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        try {
          document.execCommand("copy");
        } catch (e) {
          console.error("Clipboard copy failed:", e);
        }
        textArea.remove();
      }
    };
    executeCopy();
  };

  return (
    <div className="max-w-5xl mx-auto w-full space-y-10 animate-in fade-in duration-200">
      
      {/* P2P EXCHANGE INSTRUCTIONS BANNER */}
      <div className="bg-gradient-to-r from-blue-900/10 to-indigo-900/10 border border-blue-500/20 rounded-2xl p-6 shadow-inner relative overflow-hidden">
        <div className="absolute top-0 right-0 p-4 opacity-10 pointer-events-none">
          <Tags size={100} />
        </div>
        <h3 className="text-lg font-black text-blue-600 dark:text-blue-400 mb-2 flex items-center gap-2">
          <Zap size={18} /> The Peer-to-Peer Exchange
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed mb-4 max-w-3xl">
          You can list any unrevealed vanity address on the public Exchange to sell to other users. You set your own price in SOL. However, to guarantee cryptographic integrity for the buyer, <strong>once you click "Reveal" or "Copy", that address is permanently banned from being listed.</strong>
        </p>
        <ul className="text-xs font-bold text-zinc-500 space-y-2 relative z-10">
          <li className="flex items-center gap-2"><Check size={14} className="text-green-500"/> Listed keys are temporarily locked in the Platform Escrow.</li>
          <li className="flex items-center gap-2"><Check size={14} className="text-green-500"/> You can cancel a listing at any time to return it to your vault.</li>
          <li className="flex items-center gap-2"><Check size={14} className="text-green-500"/> The platform takes a standard 5% routing fee upon a successful sale.</li>
        </ul>
      </div>

      {/* WALLET OVERVIEW DASHBOARD */}
      <div className="bg-card border border-card-border rounded-2xl p-6 md:p-8 shadow-sm flex flex-col md:flex-row justify-between items-center gap-6 relative">
        <div className="absolute inset-0 overflow-hidden rounded-2xl pointer-events-none">
          <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/10 blur-[80px] rounded-full"></div>
        </div>
        
        <div className="relative z-10">
          <h1 className="text-3xl font-black tracking-tight flex items-center gap-3 text-foreground mb-2">
            Overview
          </h1>
          <p className="text-sm text-zinc-500">Monitor active GPU jobs and decrypt completed keys.</p>
        </div>

        <div className="flex flex-wrap items-center gap-4 relative z-10">
          {connected && balance !== null && (
            <div className="flex items-center gap-2 bg-background border border-card-border px-4 py-2.5 rounded-xl shadow-inner">
              <Coins size={18} className="text-amber-500" />
              <span className="font-bold font-mono text-foreground">
                {balance.toFixed(4)} SOL
              </span>
            </div>
          )}
          <div className="[&_.wallet-adapter-button]:bg-purple-600 [&_.wallet-adapter-button]:hover:bg-purple-700 [&_.wallet-adapter-button]:rounded-xl [&_.wallet-adapter-button]:h-[44px] [&_.wallet-adapter-button]:font-bold shadow-md">
            <WalletMultiButton />
          </div>
        </div>
      </div>

      {/* ACTIVE QUEUE */}
      <div className="bg-card border border-card-border rounded-2xl overflow-hidden shadow-sm">
        <div className="bg-background px-8 py-5 border-b border-card-border flex items-center justify-between">
          <h2 className="text-sm font-black uppercase tracking-widest flex items-center gap-2 text-foreground">
            <Activity size={18} className="text-purple-600 dark:text-purple-500" /> Active Generation Queue
          </h2>
        </div>
        
        {!connected ? (
          <div className="p-16 text-center text-zinc-500">
            <Activity size={32} className="mx-auto mb-4 opacity-50" />
            <p className="font-bold">Connect your wallet to view your active GPU tasks.</p>
          </div>
        ) : activeJobs.length === 0 ? (
          <div className="p-16 text-center text-zinc-500">
            <p className="font-bold">You have no active generation jobs running.</p>
          </div>
        ) : (
          activeJobs.map((job: any) => (
            <div key={job.id} className="p-6 md:p-8 bg-background m-4 border border-card-border rounded-xl space-y-4 relative overflow-hidden transition-all duration-300 shadow-sm hover:shadow-md">
              <div className={`absolute top-0 left-0 w-1.5 h-full ${job.status === 'PENDING' ? 'bg-amber-500' : 'bg-blue-500 animate-pulse'}`}></div>
              
              <div className={`flex flex-col sm:flex-row sm:justify-between sm:items-center font-bold mb-6 border-b border-card-border/50 pb-5 gap-4 ${job.status === 'PENDING' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400'}`}>
                {job.status === 'PENDING' ? (
                  <span className="flex items-center gap-2 text-sm tracking-widest uppercase">
                    <Clock size={18} /> 
                    WAITING IN QUEUE <span className="opacity-70">(Pos: #{queuePositions[job.id] || '...'})</span>
                  </span>
                ) : (
                  <span className="flex items-center gap-2 text-sm tracking-widest uppercase">
                    <Activity size={18} className="animate-pulse" /> 
                    {job.status === 'STARTING' ? 'INITIALIZING WORKERS...' : 'GENERATION IN PROGRESS'}
                  </span>
                )}

                <div className="flex items-center gap-4">
                  <span className="text-xs text-zinc-500 font-medium">
                    {new Date(job.created_at || Date.now()).toLocaleString()}
                  </span>
                  <button 
                    onClick={() => cancelJob(job.id)}
                    className="text-zinc-500 hover:text-red-500 bg-card hover:bg-red-50 dark:hover:bg-red-500/10 border border-card-border transition-colors px-3 py-1.5 rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider active:scale-95"
                    title="Abort Task"
                  >
                    <XCircle size={14} /> Cancel
                  </button>
                </div>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-6 gap-6 text-sm">
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5">Target Pattern</span>
                  <span className="font-black font-mono text-lg text-foreground">
                    {formatTargetPattern(job.prefix, job.suffix)}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-1"><Hash size={12}/> Keys Checked</span>
                  <span className="font-bold text-foreground text-base">
                    {job.attempts ? job.attempts.toLocaleString() : '0'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-1"><Zap size={12}/> Live Hashrate</span>
                  <span className={`font-bold text-base ${job.status === 'PENDING' ? 'text-zinc-400' : 'text-amber-600 dark:text-amber-500'}`}>
                    {job.status === 'PENDING' ? 'Waiting...' : job.hashrate ? `${(job.hashrate / 1000).toFixed(1)} kH/s` : 'Calculating...'}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-1"><Timer size={12}/> Elapsed Time</span>
                  <span className={`font-bold text-base ${job.status === 'PENDING' ? 'text-zinc-400' : 'text-foreground'}`}>
                    {job.status === 'PENDING' ? 'Waiting...' : getElapsedTime(job.created_at)}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5 flex items-center gap-1"><Percent size={12}/> Probability</span>
                  <span className={`font-bold text-base ${job.status === 'PENDING' ? 'text-zinc-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                    {job.status === 'PENDING' ? 'Waiting...' : calculateProbability(job.target_length, job.attempts)}
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 block text-[10px] font-bold uppercase tracking-widest mb-1.5">Status</span>
                  <span className={`font-black uppercase tracking-wider text-sm inline-flex items-center gap-2 ${job.status === 'PENDING' ? 'text-amber-600 dark:text-amber-500' : 'text-purple-600 dark:text-purple-500'}`}>
                    {job.status !== 'PENDING' && (
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-purple-500"></span>
                      </span>
                    )}
                    {job.status}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* COMPLETED VAULT */}
      <div className="bg-card border border-card-border rounded-2xl overflow-hidden shadow-sm">
        <div className="bg-background px-8 py-5 border-b border-card-border">
          <h2 className="text-sm font-black uppercase tracking-widest flex items-center gap-2 text-foreground">
            <ShieldCheck size={18} className="text-green-600 dark:text-green-500" /> Completed Keys Vault
          </h2>
        </div>
        
        <div className="p-6 md:p-8 space-y-6">
          {!connected && (
             <div className="text-center py-16 text-zinc-500 border border-dashed border-card-border rounded-xl">
               <Lock size={32} className="mx-auto mb-4 opacity-30" />
               <p className="font-bold">Connect your wallet to access your encrypted keys.</p>
             </div>
          )}

          {connected && !isVaultUnlocked && (
            <div className="text-center py-16 border border-card-border rounded-xl space-y-6 bg-green-50 dark:bg-green-500/5 relative overflow-hidden shadow-inner">
              <div className="bg-green-100 dark:bg-green-500/20 w-16 h-16 rounded-full flex items-center justify-center mx-auto text-green-600 dark:text-green-400 shadow-sm border border-green-200 dark:border-green-500/20">
                <Lock size={28} />
              </div>
              <div className="relative z-10">
                <h3 className="text-xl font-black text-foreground">Secure Vault Locked</h3>
                <p className="text-sm text-zinc-500 mt-2 max-w-md mx-auto leading-relaxed">
                  Your completed vanity keys are cryptographically sealed. Verify your wallet ownership to decrypt your End-to-End Encrypted (E2EE) payload.
                </p>
              </div>
              <button 
                onClick={unlockSecureVault} 
                disabled={isUnlocking}
                className="relative z-10 bg-foreground text-background font-black uppercase tracking-widest text-sm px-8 py-4 rounded-xl shadow-md hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100 mt-4 cursor-pointer"
              >
                {isUnlocking ? "Verifying Cryptographic Signature..." : "Sign to Unlock Secure Vault"}
              </button>
            </div>
          )}
          
          {connected && isVaultUnlocked && completedKeys.length === 0 && (
             <div className="space-y-8 animate-in fade-in">
               
               {/* UPSELL CTA */}
               <div className="text-center py-16 border border-card-border rounded-xl bg-purple-50 dark:bg-purple-500/5 relative overflow-hidden">
                 <div className="absolute top-0 right-0 w-64 h-64 bg-purple-500/10 blur-[80px] rounded-full pointer-events-none"></div>
                 <div className="relative z-10 flex flex-col items-center justify-center space-y-4">
                   <div className="bg-purple-100 dark:bg-purple-500/20 border border-purple-200 dark:border-purple-500/20 p-4 rounded-full text-purple-600 dark:text-purple-400 mb-2">
                     <ShoppingCart size={32} />
                   </div>
                   <h3 className="text-2xl font-black text-foreground">Your Vault is Empty</h3>
                   <p className="text-zinc-600 dark:text-zinc-400 max-w-md mx-auto text-sm">
                     Don't want to wait for the GPU cluster? Browse our Instant Storefront for pre-generated elite addresses and claim one instantly.
                   </p>
                   <button 
                     onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
                     className="mt-6 flex items-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white font-black uppercase tracking-widest text-sm px-8 py-4 rounded-xl shadow-md hover:shadow-lg hover:scale-[1.02] active:scale-95 transition-all cursor-pointer"
                   >
                     Browse Instant Inventory <ArrowRight size={18} />
                   </button>
                 </div>
               </div>
               
             </div>
          )}

          {connected && isVaultUnlocked && completedKeys.map((key) => (
            <div key={key.id} className="relative bg-background border border-card-border rounded-2xl p-6 md:p-8 transition-all animate-in fade-in shadow-sm hover:shadow-md overflow-hidden group">
              
              {/* Premium Glow Effect */}
              <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-green-500 to-blue-500 opacity-50 group-hover:opacity-100 transition-opacity"></div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 border-b border-card-border pb-5 gap-4">
                <span className="text-green-600 dark:text-green-500 font-black uppercase tracking-widest flex items-center gap-2 text-sm">
                  <Key size={18}/> {key.decryptionFailed ? "Asset Secured" : "Decrypted Asset Ready"}
                  <span className="ml-3 px-2.5 py-1 bg-card text-zinc-600 dark:text-zinc-400 rounded-md text-[10px] font-mono tracking-widest border border-card-border">
                    {formatTargetPattern(key.prefix, key.suffix)}
                  </span>
                </span>
                
                <div className="flex items-center gap-2">
                  {/* Only show listing button if it hasn't been revealed and decryption succeeded */}
                  {!key.isRevealed && !key.decryptionFailed && (
                    <button 
                      onClick={() => setListingJobId(listingJobId === key.id ? null : key.id)}
                      className="text-blue-600 dark:text-blue-400 hover:text-white bg-blue-50 hover:bg-blue-600 dark:bg-blue-500/10 dark:hover:bg-blue-500 flex items-center justify-center gap-2 transition-all px-4 py-2 rounded-lg cursor-pointer text-xs font-bold uppercase tracking-wider active:scale-95 border border-blue-200 dark:border-blue-500/30 shadow-sm"
                    >
                      <Tags size={16} /> List on Exchange
                    </button>
                  )}

                  <button onClick={() => setPendingDelete(key.id)} className="text-zinc-500 hover:text-red-500 bg-card hover:bg-red-50 dark:hover:bg-red-500/10 flex items-center justify-center gap-2 transition-colors px-4 py-2 rounded-lg cursor-pointer text-xs font-bold uppercase tracking-wider active:scale-95 border border-card-border shadow-sm">
                    <Trash2 size={16} /> Delete
                  </button>
                </div>
              </div>
              
              {/* Listing Modal Inline */}
              {listingJobId === key.id && (
                <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-500/30 rounded-xl p-6 md:p-8 my-4 animate-in fade-in shadow-inner">
                  <h3 className="text-blue-700 dark:text-blue-400 font-black uppercase tracking-widest mb-3 flex items-center gap-2">
                    <ArrowRightLeft size={20} /> List Item on P2P Exchange
                  </h3>
                  <p className="text-zinc-700 dark:text-zinc-400 text-sm leading-relaxed mb-6 max-w-2xl">
                    Set your listing price in SOL. This key will be moved to the secure Escrow database. You can cancel this listing at any time from the Exchange tab to return it to your vault.
                  </p>
                  
                  <div className="flex flex-col sm:flex-row gap-4 items-end">
                    <div className="w-full sm:w-64">
                      <label className="block text-xs font-bold text-zinc-500 uppercase tracking-widest mb-2">Listing Price (SOL)</label>
                      <input 
                        type="number" 
                        step="0.01"
                        min="0.01"
                        value={listingPrice}
                        onChange={(e) => setListingPrice(e.target.value)}
                        className="w-full bg-input border border-card-border text-foreground rounded-lg px-4 py-3 font-mono text-lg outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 transition-all"
                      />
                    </div>
                    
                    <button 
                      onClick={() => submitListing(key)}
                      disabled={isListing}
                      className="w-full sm:w-auto bg-blue-600 hover:bg-blue-500 text-white px-8 py-3.5 rounded-lg text-sm font-black uppercase tracking-widest transition-colors cursor-pointer shadow-md active:scale-95 disabled:opacity-50"
                    >
                      {isListing ? "Escrowing..." : "Confirm Listing"}
                    </button>
                    <button 
                      onClick={() => setListingJobId(null)} 
                      className="w-full sm:w-auto bg-card hover:bg-zinc-100 dark:hover:bg-zinc-800 text-foreground px-8 py-3.5 rounded-lg text-sm font-black uppercase tracking-widest transition-colors border border-card-border cursor-pointer active:scale-95"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {pendingDelete === key.id ? (
                <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50 rounded-xl p-8 my-4 animate-in fade-in shadow-inner">
                  <h3 className="text-red-600 dark:text-red-500 font-black uppercase tracking-widest mb-3 flex items-center gap-2"><AlertTriangle size={20} /> Destructive Action</h3>
                  <p className="text-zinc-700 dark:text-zinc-400 text-sm leading-relaxed mb-8">This will permanently delete the private key from our database. If you have not successfully imported this key into a wallet like Phantom or Solflare, <strong className="text-red-600 dark:text-red-400"> it will be gone forever.</strong></p>
                  <div className="flex flex-wrap gap-4">
                    <button onClick={() => executeKeyPurge(key.id)} className="bg-red-600 hover:bg-red-500 text-white px-8 py-3.5 rounded-lg text-sm font-black uppercase tracking-widest transition-colors cursor-pointer shadow-md active:scale-95">Yes, Delete Key</button>
                    <button onClick={() => setPendingDelete(null)} className="bg-card hover:bg-zinc-100 dark:hover:bg-zinc-800 text-foreground px-8 py-3.5 rounded-lg text-sm font-black uppercase tracking-widest transition-colors border border-card-border cursor-pointer active:scale-95">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-8 animate-in fade-in relative z-10">
                  <div>
                    <span className="text-zinc-500 dark:text-zinc-400 block text-[10px] font-bold uppercase tracking-widest mb-2.5">Public Address</span>
                    <div className="bg-input border border-card-border p-4 rounded-xl flex justify-between items-center shadow-sm hover:border-purple-500/30 transition-colors">
                      <input 
                        type="text" 
                        readOnly 
                        value={key.publicKey} 
                        className="bg-transparent border-none outline-none text-foreground font-mono text-base w-full cursor-text select-text"
                        onClick={(e) => e.currentTarget.select()}
                      />
                      <button onClick={() => copyToClipboard(key.publicKey, `${key.id}-pub`)} className="text-zinc-400 hover:text-blue-500 transition-colors p-1.5 rounded-md ml-2 shrink-0 active:scale-90 bg-card hover:bg-blue-50 dark:hover:bg-blue-500/10 border border-card-border" title="Copy Public Key">
                        {copiedId === `${key.id}-pub` ? <Check size={18} className="text-green-500 animate-in zoom-in duration-200" /> : <Copy size={18} className="transition-transform" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <div className="flex flex-col md:flex-row md:justify-between md:items-center mb-3 gap-4">
                      <span className="text-zinc-500 dark:text-zinc-400 block text-[10px] font-bold uppercase tracking-widest flex items-center gap-2">
                        Private Key <span className="text-red-600 dark:text-red-500 font-bold uppercase bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 px-2 py-0.5 rounded ml-2">Never Share</span>
                      </span>
                      
                      <div className="flex items-center gap-3">
                        <button onClick={() => handleSecureCopy(key, `${key.id}-phantom`)} disabled={key.decryptionFailed} className="flex items-center gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white px-5 py-2.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all active:scale-95 shadow-md disabled:opacity-50 disabled:scale-100 cursor-pointer">
                          {copiedId === `${key.id}-phantom` ? <Check size={16} className="animate-in zoom-in duration-200" /> : <Wallet size={16} />}
                          {copiedId === `${key.id}-phantom` ? "Copied! Open Phantom -> Import" : "Copy for Phantom"}
                        </button>
                        
                        <button onClick={() => handleReveal(key)} disabled={key.decryptionFailed} className="text-zinc-500 hover:text-foreground bg-card hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider cursor-pointer transition-colors px-4 py-2.5 rounded-lg active:scale-95 border border-card-border shadow-sm disabled:opacity-50 disabled:scale-100">
                          {revealKey === key.id ? <><EyeOff size={16}/> Hide</> : <><Eye size={16}/> Reveal</>}
                        </button>
                      </div>
                    </div>
                    
                    <div className="bg-input border border-card-border p-4 rounded-xl flex justify-between items-center shadow-sm hover:border-purple-500/30 transition-colors min-h-[56px]">
                      <input 
                        type="text" 
                        readOnly 
                        value={key.decryptionFailed ? key.privateKey : (revealKey === key.id ? key.privateKey : "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••")} 
                        className={`bg-transparent border-none outline-none font-mono text-sm w-full cursor-text select-text ${revealKey === key.id || key.decryptionFailed ? 'text-foreground' : 'text-zinc-500 tracking-[0.2em] md:tracking-[0.5em]'}`}
                        onClick={(e) => e.currentTarget.select()}
                      />
                      {(revealKey === key.id || key.decryptionFailed) && (
                         <button onClick={() => handleSecureCopy(key, `${key.id}-priv`)} className="text-zinc-400 hover:text-purple-500 transition-colors p-1.5 rounded-md ml-2 shrink-0 active:scale-90 bg-card hover:bg-purple-50 dark:hover:bg-purple-500/10 border border-card-border" title="Copy Private Key">
                           {copiedId === `${key.id}-priv` ? <Check size={18} className="text-green-500 animate-in zoom-in duration-200" /> : <Copy size={18} className="transition-transform" />}
                         </button>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}