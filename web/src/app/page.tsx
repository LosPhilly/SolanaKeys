"use client";

import dynamic from "next/dynamic";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import Image from "next/image";
import { Zap, Moon, Sun, Monitor, ArrowRight } from "lucide-react";

import GeneratorView from "@/components/views/GeneratorView";
import MarketplaceView from "@/components/views/MarketplaceView";
import VaultView from "@/components/views/VaultView";
import ExchangeView from "@/components/views/ExchangeView";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((mod) => mod.WalletMultiButton),
  { ssr: false }
);

export default function Home() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [activeTab, setActiveTab] = useState<"create" | "marketplace" | "vault" | "exchange">("create");

  useEffect(() => setMounted(true), []);

  return (
    <div className="min-h-screen flex flex-col font-sans">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full flex-grow">
        
        {/* HEADER */}
        <header className="flex justify-between items-center mb-10 pb-6 border-b border-card-border">
          <div className="flex items-center gap-4">
            <div className="h-10 w-10 bg-gradient-to-tr from-purple-600 to-indigo-600 rounded-lg flex items-center justify-center">
              <Zap className="text-white" size={20} />
            </div>
            <h1 className="text-xl font-black text-foreground">SOLANAKEYS</h1>
          </div>
          <div className="flex items-center gap-3">
            <WalletMultiButton />
          </div>
        </header>

        {/* HERO SECTION: The "Hook" */}
        <section className="mb-16 grid lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-6">
                <h2 className="text-5xl font-black tracking-tight leading-tight">
                    Own Your Address. <br />
                    <span className="text-purple-500">Own Your Brand.</span>
                </h2>
                <p className="text-zinc-500 text-lg">
                    Generate cryptographically secure, custom Solana vanity addresses at bare-metal speeds. Instant delivery, E2EE vault security, and zero-trust escrow.
                </p>
                <div className="flex gap-4 pt-4">
                    <button onClick={() => setActiveTab("create")} className="bg-foreground text-background px-8 py-4 rounded-xl font-black flex items-center gap-2 hover:opacity-90 transition-opacity">
                        Generate Now <ArrowRight size={18}/>
                    </button>
                </div>
            </div>
            <div className="relative animate-in fade-in zoom-in duration-700">
                <Image 
                    src="/images/solana-vanity-address-generator.jpg"
                    alt="SolanaKeys GPU Vanity Address Generator"
                    width={800}
                    height={450}
                    className="rounded-2xl shadow-[0_0_50px_-12px_rgba(168,85,247,0.3)] border border-card-border"
                    priority
                />
            </div>
        </section>

        {/* NAVIGATION TABS: The "Bridge" */}
        <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-md py-4 mb-8 -mx-4 px-4 sm:mx-0 sm:px-0">
            <div className="flex flex-wrap gap-2 p-1 bg-card border border-card-border rounded-xl">
            {[
                { id: "create", label: "Generator" },
                { id: "marketplace", label: "Storefront" },
                { id: "exchange", label: "P2P Exchange" },
                { id: "vault", label: "My Vault" },
            ].map((tab) => (
                <button 
                key={tab.id} 
                onClick={() => setActiveTab(tab.id as any)} 
                className={`flex-1 px-4 py-3 text-sm font-black rounded-lg transition-all cursor-pointer ${activeTab === tab.id ? "bg-foreground text-background shadow-md" : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"}`}
                >
                {tab.label}
                </button>
            ))}
            </div>
        </nav>

        {/* CONTENT */}
        <main className="min-h-[500px]">
          {activeTab === "create" && <GeneratorView onJobQueued={() => setActiveTab("vault")} />}
          {activeTab === "marketplace" && <MarketplaceView />}
          {activeTab === "exchange" && <ExchangeView />}
          {activeTab === "vault" && <VaultView />}
        </main>
      </div>

      <footer className="border-t border-card-border mt-20 py-12 text-center text-sm text-zinc-500">
        © {new Date().getFullYear()} SolanaKeys. Secure hardware-generated assets.
      </footer>
    </div>
  );
}