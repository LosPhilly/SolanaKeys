"use client";

import dynamic from "next/dynamic";
import { useState, useEffect } from "react";
import { useTheme } from "next-themes";
import Image from "next/image"; // IMPORTED
import { Zap, Moon, Sun, Monitor } from "lucide-react";

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
    <div className="min-h-screen flex flex-col font-sans selection:bg-purple-500/30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 w-full flex-grow">
        
        {/* HEADER */}
        <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-10 gap-4 border-b border-card-border pb-6">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 bg-gradient-to-tr from-purple-600 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
              <Zap className="text-white" size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-black tracking-tight leading-none text-foreground">
                SOLANA<span className="text-purple-600 dark:text-purple-500 font-light">KEYS</span>
              </h1>
              <p className="text-xs text-zinc-500 font-medium mt-1">Premium Vanity Address Generator</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            {mounted && (
              <div className="flex bg-card border border-card-border rounded-lg p-1">
                <button onClick={() => setTheme("light")} className={`p-2 rounded-md transition-colors cursor-pointer ${theme === "light" ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}>
                  <Sun size={16} />
                </button>
                <button onClick={() => setTheme("system")} className={`p-2 rounded-md transition-colors cursor-pointer ${theme === "system" ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}>
                  <Monitor size={16} />
                </button>
                <button onClick={() => setTheme("dark")} className={`p-2 rounded-md transition-colors cursor-pointer ${theme === "dark" ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-sm" : "text-zinc-500 hover:text-zinc-700"}`}>
                  <Moon size={16} />
                </button>
              </div>
            )}
            <div className="[&_.wallet-adapter-button]:bg-purple-600 [&_.wallet-adapter-button]:hover:bg-purple-700 [&_.wallet-adapter-button]:rounded-lg [&_.wallet-adapter-button]:h-[44px] [&_.wallet-adapter-button]:font-bold [&_.wallet-adapter-button]:shadow-md">
              <WalletMultiButton />
            </div>
          </div>
        </header>

        {/* SEO IMAGE INSERTION */}
        <div className="mb-12 flex justify-center animate-in fade-in zoom-in duration-500">
           <Image 
             src="/images/sk_seo.jpg"
             alt="SolanaKeys GPU-accelerated vanity address generator"
             width={1200}
             height={630}
             className="rounded-2xl shadow-2xl border border-card-border max-w-full h-auto"
             priority
           />
        </div>

        {/* NAVIGATION TABS */}
        <div className="flex flex-wrap gap-3 mb-10">
          {[
            { id: "create", label: "Create Custom Address" },
            { id: "marketplace", label: "Instant Storefront" },
            { id: "exchange", label: "P2P Exchange" },
            { id: "vault", label: "My Vault" },
          ].map((tab) => (
            <button 
              key={tab.id} 
              onClick={() => setActiveTab(tab.id as any)} 
              className={`px-6 py-3 text-sm font-bold rounded-lg transition-all border cursor-pointer ${activeTab === tab.id ? "border-foreground bg-foreground text-background shadow-md" : "border-card-border bg-card text-zinc-600 dark:text-zinc-400 hover:border-zinc-400 dark:hover:border-zinc-600"}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ISOLATED VIEW ROUTING */}
        <main className="relative">
          {activeTab === "create" && <GeneratorView onJobQueued={() => setActiveTab("vault")} />}
          {activeTab === "marketplace" && <MarketplaceView />}
          {activeTab === "exchange" && <ExchangeView />}
          {activeTab === "vault" && <VaultView />}
        </main>
      </div>

      <footer className="border-t border-card-border mt-16 bg-card/50">
        <div className="max-w-7xl mx-auto px-4 py-8 text-center text-sm text-zinc-500 font-medium">
          © {new Date().getFullYear()} SolanaKeys. Providing secure, hardware-generated vanity addresses.
        </div>
      </footer>
    </div>
  );
}