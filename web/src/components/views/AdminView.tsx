"use client";

import { useState, useEffect, useMemo } from "react";
import { supabase } from "../../utils/supabase";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { 
  ShieldAlert, Trash2, Activity, Database, Lock, RefreshCcw, 
  LayoutDashboard, Store, ArrowRightLeft, Settings, Cpu, 
  DollarSign, Flame, Server, Key, History, Undo2, Users, 
  TrendingUp, BarChart3, AlertCircle, Thermometer
} from "lucide-react";

export default function AdminView() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signMessage } = useWallet();
  
  // Data State
  const [inventory, setInventory] = useState<any[]>([]);
  const [escrow, setEscrow] = useState<any[]>([]);
  const [completedJobs, setCompletedJobs] = useState<any[]>([]);
  const [activeJobsCount, setActiveJobsCount] = useState<number>(0);
  const [workerTelemetry, setWorkerTelemetry] = useState<any[]>([]);
  
  // UI State
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'inventory' | 'escrow' | 'history' | 'settings'>('dashboard');
  const [processingId, setProcessingId] = useState<string | null>(null);

  const adminWallet = process.env.NEXT_PUBLIC_ADMIN_WALLET;
  const isAuthorized = publicKey && adminWallet && publicKey.toBase58() === adminWallet;

  useEffect(() => {
    if (isAuthorized) {
      fetchAllData();
      
      // Set up a quiet 3-second polling interval specifically for hardware telemetry updates
      const telemetryInterval = setInterval(() => {
        fetchHardwareTelemetry();
      }, 3000);

      return () => clearInterval(telemetryInterval);
    }
  }, [isAuthorized]);

  const fetchHardwareTelemetry = async () => {
    try {
      const { data } = await supabase
        .from('worker_telemetry')
        .select('*')
        .order('gpu_id', { ascending: true });
      if (data) setWorkerTelemetry(data);
    } catch (err) {
      console.error("Failed to sync worker telemetry stream", err);
    }
  };

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const [invRes, escRes, histRes, jobsRes, telRes] = await Promise.all([
        supabase.from('premium_inventory').select('*').order('created_at', { ascending: false }),
        supabase.from('vanity_jobs').select('*').eq('is_listed', true).order('created_at', { ascending: false }),
        supabase.from('vanity_jobs').select('*').in('status', ['COMPLETED', 'FAILED', 'REFUNDED']).order('completed_at', { ascending: false }).limit(100),
        supabase.from('vanity_jobs').select('id', { count: 'exact' }).eq('status', 'PROCESSING'),
        supabase.from('worker_telemetry').select('*').order('gpu_id', { ascending: true })
      ]);

      if (invRes.data) setInventory(invRes.data);
      if (escRes.data) setEscrow(escRes.data);
      if (histRes.data) setCompletedJobs(histRes.data);
      if (jobsRes.count !== null) setActiveJobsCount(jobsRes.count);
      if (telRes.data) setWorkerTelemetry(telRes.data);
      
    } catch (err) {
      console.error("Failed to fetch admin data", err);
    }
    setLoading(false);
  };

  const handleBurn = async (id: string, table: 'premium_inventory' | 'vanity_jobs') => {
    if (!publicKey || !signMessage) {
      alert("Wallet not connected or does not support message signing.");
      return;
    }

    if (!confirm("CRITICAL WARNING: This will permanently delete this key from the database. It cannot be undone.")) return;

    setProcessingId(id);
    try {
      // Sign a deterministic message that commits to exactly this action.
      // The server verifies this signature — no passphrase needed.
      const msgStr = `Authenticate to SolanaKeys Admin.\nAction: BURN\nItem ID: ${id}\nTable: ${table}`;
      const sigBytes = await signMessage(new TextEncoder().encode(msgStr));
      const signature = bs58.encode(sigBytes);

      const response = await fetch('/api/admin/burn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemId: id,
          table,
          adminWallet: publicKey.toBase58(),
          message: msgStr,
          signature,
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Burn command rejected by server.");
      }

      await fetchAllData();
    } catch (error: any) {
      if (error.message?.includes("User rejected") || error.message?.includes("rejected the request")) {
        // Admin cancelled the signing prompt — silent
      } else {
        console.error(error);
        alert(`Failed: ${error.message}`);
      }
    } finally {
      setProcessingId(null);
    }
  };

  const handleRefundJob = async (job: any) => {
    const suggestedRefund = job.price_paid ? job.price_paid.toString() : "0.00";
    
    const refundAmountStr = prompt(`How much SOL do you want to refund to ${job.customer_wallet}? \n\nRecorded Price Paid: ${suggestedRefund} SOL`, suggestedRefund);
    if (!refundAmountStr) return; 
    
    const refundAmount = parseFloat(refundAmountStr);
    if (isNaN(refundAmount) || refundAmount <= 0) {
      alert("Invalid refund amount.");
      return;
    }

    if (!confirm(`FINAL CHECK: Send ${refundAmount} SOL to ${job.customer_wallet} and mark Job ${job.id.substring(0,6)} as REFUNDED?`)) return;
    
    setProcessingId(job.id);
    try {
      if (!publicKey) throw new Error("Admin wallet not connected.");

      const recipientPubKey = new PublicKey(job.customer_wallet);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

      const transaction = new Transaction({
        feePayer: publicKey,
        blockhash,
        lastValidBlockHeight
      }).add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: recipientPubKey,
          lamports: Math.round(refundAmount * LAMPORTS_PER_SOL), 
        })
      );

      const signature = await sendTransaction(transaction, connection);
      
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight
      }, 'confirmed');

      // --- FORCE TYPE BYPASS VIA EXPLICIT CASTING ---
      const { error } = await (supabase as any)
        .from('vanity_jobs')
        .update({ status: 'REFUNDED' })
        .eq('id', job.id);
        
      if (error) throw error;
      
      await fetchAllData();
      alert(`Successfully refunded ${refundAmount} SOL! Signature: ${signature}`);
      
    } catch (error: any) {
      console.error("Refund error:", error);
      alert(`Refund failed: ${error.message}`);
    } finally {
      setProcessingId(null);
    }
  };

  const stats = useMemo(() => {
    const totalInvValue = inventory.reduce((sum, item) => sum + (Number(item.price_sol) || 0), 0);
    const totalEscrowValue = escrow.reduce((sum, item) => sum + (Number(item.listing_price) || 0), 0);
    
    const customJobRevenue = completedJobs
      .filter(job => job.status === 'COMPLETED' && !job.is_listed)
      .reduce((sum, job) => sum + (Number(job.price_paid) || 0), 0);

    const totalVolume = totalInvValue + totalEscrowValue + customJobRevenue;

    const successfulJobs = completedJobs.filter(j => j.status === 'COMPLETED').length;
    const failedJobs = completedJobs.filter(j => j.status === 'FAILED' || j.status === 'REFUNDED').length;
    const successRate = (successfulJobs + failedJobs) > 0 
      ? ((successfulJobs / (successfulJobs + failedJobs)) * 100).toFixed(1) 
      : "0.0";

    const uniqueUsers = new Set([
      ...completedJobs.map(j => j.customer_wallet),
      ...escrow.map(e => e.customer_wallet)
    ]).size;

    // Aggregate computational parameters from isolated worker threads
    const totalClusterHashrate = workerTelemetry.reduce((sum, w) => sum + (Number(w.local_hashrate) || 0), 0);
    const totalClusterAttempts = workerTelemetry.reduce((sum, w) => sum + (Number(w.local_attempts) || 0), 0);

    return {
      inventoryValue: totalInvValue.toFixed(2),
      escrowFees: (totalEscrowValue * 0.05).toFixed(2), 
      completedRevenue: customJobRevenue.toFixed(2),
      totalVolume: totalVolume.toFixed(2),
      successRate,
      uniqueUsers,
      totalKeys: inventory.length + escrow.length,
      clusterHashrate: (totalClusterHashrate / 1e6).toFixed(2), // Converts to Mh/s format cleanly
      clusterAttempts: totalClusterAttempts.toLocaleString()
    };
  }, [inventory, escrow, completedJobs, workerTelemetry]);

  if (!isAuthorized) {
    return (
      <div className="py-32 flex flex-col items-center justify-center bg-background min-h-[60vh] rounded-xl border border-card-border bg-card max-w-7xl mx-auto w-full">
        <div className="w-20 h-20 bg-red-100 dark:bg-red-500/10 rounded-full flex items-center justify-center mb-6 border border-red-200 dark:border-red-500/20">
          <ShieldAlert size={40} className="text-red-500" />
        </div>
        <h2 className="text-3xl font-black text-foreground mb-3 tracking-tight">Command Center Locked</h2>
        <p className="text-zinc-600 dark:text-zinc-400 max-w-md text-center text-base">
          Unauthorized node detected. You must connect the Master Treasury Wallet to access telemetry and database functions.
        </p>
      </div>
    );
  }

  return (
    <div className="text-foreground pb-24">
      <div className="max-w-7xl mx-auto w-full space-y-8 animate-in fade-in duration-200">
        
        {/* ================= HEADER ================= */}
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-card border border-card-border rounded-xl p-6 shadow-sm">
          <div>
            <h2 className="text-2xl font-black text-foreground flex items-center gap-3 tracking-tight">
              <Server className="text-purple-600 dark:text-purple-500" size={24} /> 
              Array Command
            </h2>
            <p className="text-zinc-500 mt-1 text-sm font-medium">SysAdmin & Hardware Telemetry Interface</p>
          </div>
          <div className="flex items-center gap-3">
            <button 
              onClick={fetchAllData} 
              className="p-3 rounded-lg bg-background border border-card-border hover:border-zinc-400 dark:hover:border-zinc-600 transition-all text-zinc-500 hover:text-foreground active:scale-95 shadow-sm"
            >
              <RefreshCcw size={18} className={`${loading ? 'animate-spin text-purple-600 dark:text-purple-500' : ''}`} />
            </button>
            <div className="flex items-center gap-2 bg-green-50 dark:bg-green-500/10 px-4 py-2.5 rounded-lg border border-green-200 dark:border-green-500/20">
              <Lock size={16} className="text-green-600 dark:text-green-500" />
              <span className="text-xs font-bold text-green-700 dark:text-green-400 uppercase tracking-wider">Admin Auth Active</span>
            </div>
          </div>
        </div>

        {/* ================= TABS ================= */}
        <div className="flex flex-wrap gap-3 border-b border-card-border pb-6 overflow-x-auto no-scrollbar">
          {[
            { id: 'dashboard', icon: LayoutDashboard, label: 'Telemetry' },
            { id: 'inventory', icon: Store, label: `Inventory (${inventory.length})` },
            { id: 'escrow', icon: ArrowRightLeft, label: `Escrow (${escrow.length})` },
            { id: 'history', icon: History, label: 'Audit Log' },
            { id: 'settings', icon: Settings, label: 'Security' }
          ].map((tab) => (
            <button 
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all border cursor-pointer shrink-0 ${
                activeTab === tab.id 
                  ? "border-foreground bg-foreground text-background shadow-md" 
                  : "border-card-border bg-card text-zinc-600 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-600"
              }`}
            >
              <tab.icon size={16} /> {tab.label}
            </button>
          ))}
        </div>

        {/* ================= TAB 1: DASHBOARD ================= */}
        {activeTab === 'dashboard' && (
          <div className="space-y-8 animate-in fade-in">
            
            {/* Network Financials */}
            <div>
              <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <BarChart3 size={16}/> Global Financial Metrics
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="bg-card border border-card-border p-6 rounded-xl relative overflow-hidden group hover:border-purple-500/50 transition-all shadow-sm">
                  <span className="text-xs font-bold text-purple-600 dark:text-purple-400 uppercase tracking-wider">Network Volume</span>
                  <h4 className="text-3xl font-black text-foreground mt-2">{stats.totalVolume} <span className="text-base font-medium text-zinc-500">SOL</span></h4>
                </div>
                <div className="bg-card border border-card-border p-6 rounded-xl relative overflow-hidden group hover:border-green-500/50 transition-all shadow-sm">
                  <span className="text-xs font-bold text-green-600 dark:text-green-500 uppercase tracking-wider">Inventory Value</span>
                  <h4 className="text-3xl font-black text-foreground mt-2">{stats.inventoryValue} <span className="text-base font-medium text-zinc-500">SOL</span></h4>
                </div>
                <div className="bg-card border border-card-border p-6 rounded-xl relative overflow-hidden group hover:border-blue-500/50 transition-all shadow-sm">
                  <span className="text-xs font-bold text-blue-600 dark:text-blue-500 uppercase tracking-wider">P2P Fees (5%)</span>
                  <h4 className="text-3xl font-black text-foreground mt-2">{stats.escrowFees} <span className="text-base font-medium text-zinc-500">SOL</span></h4>
                </div>
                <div className="bg-card border border-card-border p-6 rounded-xl relative overflow-hidden group hover:border-orange-500/50 transition-all shadow-sm">
                  <span className="text-xs font-bold text-orange-600 dark:text-orange-500 uppercase tracking-wider">Gen Revenue</span>
                  <h4 className="text-3xl font-black text-foreground mt-2">{stats.completedRevenue} <span className="text-base font-medium text-zinc-500">SOL</span></h4>
                </div>
              </div>
            </div>

            {/* REAL-TIME HARDWARE NODE MAP SUB-PANEL */}
            <div>
              <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Cpu size={16}/> Dynamic Silicon Matrix Cluster
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[0, 1, 2, 3].map((gpuIdx) => {
                  const telemetryNode = workerTelemetry.find(w => w.gpu_id === gpuIdx);
                  const nodeSpeed = telemetryNode ? (Number(telemetryNode.local_hashrate) / 1e6).toFixed(2) : "0.00";
                  const nodeHashes = telemetryNode ? Number(telemetryNode.local_attempts).toLocaleString() : "0";
                  const nodeActive = telemetryNode && (new Date().getTime() - new Date(telemetryNode.updated_at).getTime() < 12000);

                  return (
                    <div key={gpuIdx} className="bg-card border border-card-border p-5 rounded-xl shadow-sm space-y-4 hover:border-purple-500/30 transition-all">
                      <div className="flex justify-between items-center">
                        <div className="flex items-center gap-2">
                          <Cpu size={18} className={nodeActive ? "text-purple-500 animate-pulse" : "text-zinc-400"} />
                          <span className="text-sm font-black font-mono">GPU NODE #{gpuIdx}</span>
                        </div>
                        <span className={`w-2 h-2 rounded-full ${nodeActive ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]' : 'bg-zinc-300'}`} />
                      </div>
                      
                      <div className="space-y-1.5 font-mono text-xs">
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Node Speed:</span>
                          <span className="font-bold text-foreground">{nodeSpeed} Mh/s</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Node Volume:</span>
                          <span className="text-zinc-500 truncate max-w-[120px]">{nodeHashes}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-400">Status Map:</span>
                          <span className={nodeActive ? "text-green-500 font-semibold" : "text-zinc-400"}>
                            {nodeActive ? "COMPUTING" : "STANDBY"}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Hardware & Network Telemetry Overview */}
            <div>
              <h3 className="text-sm font-bold text-zinc-500 uppercase tracking-wider mb-4 flex items-center gap-2">
                <Activity size={16}/> Silicon Array Aggregate Overviews
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-card border border-card-border p-6 rounded-xl flex items-center gap-4 shadow-sm">
                   <div className="bg-background p-3 rounded-lg border border-card-border text-foreground"><Cpu size={24}/></div>
                   <div>
                     <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider mb-0.5">Cluster Core Velocity</p>
                     <h4 className="text-lg font-mono text-foreground font-semibold">{stats.clusterHashrate} Mh/s Total</h4>
                   </div>
                </div>
                <div className="bg-card border border-card-border p-6 rounded-xl flex items-center gap-4 shadow-sm">
                   <div className="bg-background p-3 rounded-lg border border-card-border text-foreground"><Users size={24}/></div>
                   <div>
                     <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider mb-0.5">Unique User Wallets</p>
                     <h4 className="text-lg font-mono text-foreground font-semibold">{stats.uniqueUsers} Connected</h4>
                   </div>
                </div>
                <div className="bg-card border border-card-border p-6 rounded-xl flex items-center gap-4 shadow-sm">
                   <div className="bg-background p-3 rounded-lg border border-card-border text-foreground"><Activity size={24}/></div>
                   <div>
                     <p className="text-xs text-zinc-500 font-bold uppercase tracking-wider mb-0.5">Job Success Rate</p>
                     <h4 className="text-lg font-mono text-green-600 dark:text-green-500 font-semibold">{stats.successRate}% Yield</h4>
                   </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ================= TABS 2 & 3: GRIDS ================= */}
        {(activeTab === 'inventory' || activeTab === 'escrow') && (
          <div className="bg-card border border-card-border rounded-xl shadow-sm overflow-hidden animate-in fade-in">
            {loading ? (
              <div className="py-24 flex flex-col items-center justify-center text-zinc-500">
                <Activity size={32} className="animate-pulse mb-4 text-purple-600 dark:text-purple-500" />
                <p className="font-medium text-sm">Querying database...</p>
              </div>
            ) : (activeTab === 'inventory' ? inventory : escrow).length === 0 ? (
              <div className="py-24 text-center text-zinc-500 font-medium text-sm border-2 border-dashed border-card-border m-6 rounded-xl bg-background">
                No active records found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="bg-background border-b border-card-border text-xs uppercase tracking-wider text-zinc-500 font-bold">
                      <th className="px-6 py-4">Target Pattern</th>
                      <th className="px-6 py-4">Database ID</th>
                      <th className="px-6 py-4">Value</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border">
                    {(activeTab === 'inventory' ? inventory : escrow).map((item) => (
                      <tr key={item.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors group">
                        <td className="px-6 py-4 font-mono text-foreground font-semibold text-sm">
                          {activeTab === 'inventory' ? item.matched_pattern : (item.prefix || "") + "..." + (item.suffix || "")}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-zinc-500">
                          {item.id}
                        </td>
                        <td className="px-6 py-4 font-mono text-green-600 dark:text-green-500 font-medium text-sm">
                          {activeTab === 'inventory' ? item.price_sol : item.listing_price} SOL
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button
                            onClick={() => handleBurn(item.id, activeTab === 'inventory' ? 'premium_inventory' : 'vanity_jobs')}
                            disabled={processingId === item.id}
                            className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/20 hover:bg-red-600 hover:text-white dark:hover:bg-red-500 transition-all disabled:opacity-50 text-xs font-bold shadow-sm active:scale-95"
                          >
                            {processingId === item.id ? <Activity size={14} className="animate-spin" /> : <><Trash2 size={14} className="mr-2"/> Burn Payload</>}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ================= TAB 4: JOB HISTORY & REFUNDS ================= */}
        {activeTab === 'history' && (
          <div className="bg-card border border-card-border rounded-xl shadow-sm overflow-hidden animate-in fade-in">
            {loading ? (
              <div className="py-24 flex flex-col items-center justify-center text-zinc-500">
                <Activity size={32} className="animate-pulse mb-4 text-purple-600 dark:text-purple-500" />
                <p className="font-medium text-sm">Fetching network audit log...</p>
              </div>
            ) : completedJobs.length === 0 ? (
              <div className="py-24 text-center text-zinc-500 font-medium text-sm border-2 border-dashed border-card-border m-6 rounded-xl bg-background">
                No recent activity logs.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="bg-background border-b border-card-border text-xs uppercase tracking-wider text-zinc-500 font-bold">
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Target Pattern</th>
                      <th className="px-6 py-4">Customer Wallet</th>
                      <th className="px-6 py-4">Price Paid</th>
                      <th className="px-6 py-4">Date</th>
                      <th className="px-6 py-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-card-border">
                    {completedJobs.map((job) => (
                      <tr key={job.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors">
                        <td className="px-6 py-4">
                          <span className={`px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider border 
                            ${job.status === 'COMPLETED' ? 'bg-green-50 dark:bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-500/20' : 
                              job.status === 'FAILED' ? 'bg-red-50 dark:bg-red-500/10 text-red-700 dark:text-red-400 border-red-200 dark:border-red-500/20' : 
                              'bg-orange-50 dark:bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-200 dark:border-orange-500/20'}`}>
                            {job.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono text-foreground font-semibold text-sm">
                          {(job.prefix || "") + "..." + (job.suffix || "")}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs text-zinc-500">
                          {job.customer_wallet.substring(0,8)}...{job.customer_wallet.substring(job.customer_wallet.length-8)}
                        </td>
                        <td className="px-6 py-4 font-mono text-xs font-semibold text-foreground">
                          {job.price_paid ? `${job.price_paid} SOL` : <span className="text-zinc-400 font-normal">N/A</span>}
                        </td>
                        <td className="px-6 py-4 text-sm text-zinc-500 font-medium">
                          {new Date(job.created_at).toLocaleDateString()}
                        </td>
                        <td className="px-6 py-4 text-right">
                          {job.status === 'FAILED' && (
                            <button
                              onClick={() => handleRefundJob(job)}
                              disabled={processingId === job.id}
                              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-orange-50 dark:bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-200 dark:border-orange-500/20 hover:bg-orange-600 hover:text-white dark:hover:bg-orange-500 transition-all disabled:opacity-50 text-xs font-bold shadow-sm active:scale-95"
                              title="Process Refund"
                            >
                              {processingId === job.id ? <Activity size={14} className="animate-spin" /> : <><Undo2 size={14} className="mr-2"/> Issue Refund</>}
                            </button>
                          )}
                          {job.status === 'COMPLETED' && <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Settled</span>}
                          {job.status === 'REFUNDED' && <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider line-through">Refunded</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ================= TAB 5: SECURITY SETTINGS ================= */}
        {activeTab === 'settings' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-in fade-in">
            
            <div className="bg-card border border-card-border p-8 rounded-xl shadow-sm relative overflow-hidden">
              <div className="w-12 h-12 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-500 rounded-xl flex items-center justify-center mb-6">
                <AlertCircle size={24} />
              </div>
              <h3 className="text-xl font-bold text-foreground mb-2">Master Passphrase</h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
                Your Burning Passphrase prevents unauthorized API requests from destroying inventory. This is hardcoded into the server architecture.
              </p>
              <div className="bg-background rounded-lg p-5 border border-card-border">
                <span className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Sysadmin Instructions:</span>
                <ol className="text-sm text-zinc-600 dark:text-zinc-400 space-y-3 font-mono ml-4 list-decimal">
                  <li>Access server root directory or Vercel dashboard.</li>
                  <li>Modify <span className="text-purple-600 dark:text-purple-400 font-bold bg-purple-50 dark:bg-purple-500/10 px-1.5 py-0.5 rounded">ADMIN_PASSPHRASE</span> in <span className="text-foreground">.env.local</span></li>
                  <li>Restart Node.js process / Redeploy.</li>
                </ol>
              </div>
            </div>

            <div className="bg-card border border-card-border p-8 rounded-xl shadow-sm relative overflow-hidden">
              <div className="w-12 h-12 bg-blue-50 dark:bg-blue-500/10 border border-blue-200 dark:border-blue-500/20 text-blue-600 dark:text-blue-500 rounded-xl flex items-center justify-center mb-6">
                <Key size={24} />
              </div>
              <h3 className="text-xl font-bold text-foreground mb-2">Zk-Encryption Engine</h3>
              <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6 leading-relaxed">
                Active Master Inventory Key rotation secures untransferred payloads. Your database handles backwards compatibility automatically.
              </p>
              <div className="bg-background rounded-lg p-5 border border-card-border">
                <span className="block text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Live Configuration:</span>
                <div className="space-y-3 font-mono text-sm">
                  <div className="flex justify-between border-b border-card-border pb-3">
                    <span className="text-zinc-500">ACTIVE_MASTER_KEY</span>
                    <span className="text-green-700 dark:text-green-400 font-bold bg-green-50 dark:bg-green-500/10 px-2 py-0.5 rounded border border-green-200 dark:border-green-500/20">v1</span>
                  </div>
                  <div className="flex justify-between pt-1">
                    <span className="text-zinc-500">MASTER_KEYS_ENV Loaded</span>
                    <span className="text-foreground font-medium">1 Version</span>
                  </div>
                </div>
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}