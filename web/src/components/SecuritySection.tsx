"use client";

import { Shield, EyeOff, Trash2, Github, HelpCircle } from "lucide-react";

export default function SecuritySection() {
  return (
    <div className="max-w-5xl mx-auto py-16 px-4 space-y-16 animate-in fade-in duration-200">
      
      {/* Hero Header */}
      <div className="text-center max-w-2xl mx-auto space-y-4">
        <div className="bg-purple-100 dark:bg-purple-500/10 w-14 h-14 rounded-full flex items-center justify-center mx-auto text-purple-600 dark:text-purple-400">
          <Shield size={32} />
        </div>
        <h1 className="text-3xl font-black tracking-tight md:text-4xl text-foreground">
          Trust &amp; Security Architecture
        </h1>
        <p className="text-sm text-zinc-500 md:text-base leading-relaxed">
          Generating an Ed25519 private key on remote hardware requires absolute safety. 
          We don't ask for your trust—we provide the open-source blueprint of our zero-retention pipeline.
        </p>
      </div>

      {/* The Core 3-Step Pipeline */}
      <div className="bg-card border border-card-border rounded-xl p-8 shadow-sm">
        <h2 className="text-xl font-black mb-6 flex items-center gap-2 border-b border-card-border pb-4">
          <EyeOff size={20} className="text-purple-500" /> The Zero-Knowledge Handover Pipeline
        </h2>
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-widest text-purple-500">Step 1</div>
            <h3 className="font-bold text-foreground">Ephemeral Generation</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              The key pair is generated natively inside the volatile VRAM registers of an isolated GPU worker running an optimized C++/CUDA core. It never touches permanent physical media.
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-widest text-purple-500">Step 2</div>
            <h3 className="font-bold text-foreground">Client-Side Encryption</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              The worker immediately encrypts the private key payload via public-key cryptography derived from your connected wallet session. The unencrypted raw plaintext is instantly overwritten in GPU memory.
            </p>
          </div>

          <div className="space-y-2">
            <div className="text-xs font-bold uppercase tracking-widest text-purple-500">Step 3</div>
            <h3 className="font-bold text-foreground">Encrypted Vault Delivery</h3>
            <p className="text-xs text-zinc-500 leading-relaxed">
              The securely locked payload is delivered to our Supabase cluster. It remains unreadable to everyone—including our platform administrators—until decrypted by your unique browser session wallet signature.
            </p>
          </div>
        </div>
      </div>

      {/* Destructive Action Explanation */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-center bg-zinc-50 dark:bg-[#0a0a0a] border border-card-border rounded-xl p-8 shadow-sm">
        <div className="space-y-3">
          <h2 className="text-xl font-black flex items-center gap-2">
            <Trash2 size={20} className="text-red-500" /> Wiping Your Footprint
          </h2>
          <p className="text-sm text-zinc-500 leading-relaxed">
            The moment you safely reveal, extract, and copy your private key inside your dashboard, you can invoke a **Hard Purge** operation. 
          </p>
          <p className="text-sm text-zinc-500 leading-relaxed">
            Clicking **"Delete From Server"** fires an irreversible row-level instruction directly to our database clusters. We do not maintain archival backups or shadow retention tables for key assets. Once deleted, the record ceases to exist globally.
          </p>
        </div>
        <div className="bg-input border border-card-border rounded-lg p-5 font-mono text-xs space-y-2 shadow-inner">
          <div className="text-purple-500 font-bold">// Runtime Hard Purge State Loop</div>
          <div className="text-zinc-400">[User Action] ──&gt; Click Delete Button</div>
          <div className="text-zinc-400">[API Trigger] ──&gt; Execute Destructive SQL Query</div>
          <div className="text-zinc-400">[Node Cluster] ──&gt; Flushed from Memory Cache</div>
          <div className="text-green-500 font-bold">[Status] SUCCESS: Target Key Permanently Extinguished</div>
        </div>
      </div>

      {/* Radical Transparency Section */}
      <div className="space-y-6 text-center max-w-3xl mx-auto">
        <h2 className="text-2xl font-black flex items-center justify-center gap-2">
          <img src="/github-icon.svg" className="w-6 h-6 dark:invert" alt="" /> Radical Open Source Transparency
        </h2>
        <p className="text-sm text-zinc-500 leading-relaxed">
          We operate under a strict "verify, don't trust" philosophy. The entirely independent layers powering this system are public, unredacted, and open for technical inspection, local compilations, and validation.
        </p>
        <div className="flex flex-col sm:flex-row gap-4 justify-center pt-4">
          <a 
            href="https://github.com/solanakeys/solanakeys-web" 
            target="_blank" 
            className="flex items-center justify-center gap-2 px-6 py-3 bg-foreground text-background font-bold text-sm rounded-lg hover:scale-[1.02] active:scale-[0.98] transition-all"
          >
            <Github size={16} /> Inspect Web Frontend Repo
          </a>
          <a 
            href="https://github.com/solanakeys/solanakeys-worker" 
            target="_blank" 
            className="flex items-center justify-center gap-2 px-6 py-3 bg-card border border-card-border font-bold text-sm rounded-lg hover:scale-[1.02] active:scale-[0.98] transition-all text-foreground hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
          >
            <Github size={16} /> Inspect CUDA Core Worker Repo
          </a>
        </div>
      </div>

    </div>
  );
}