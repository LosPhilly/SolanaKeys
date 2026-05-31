import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { WalletContextProvider } from "@/components/WalletContextProvider";

// Fixes the broken wallet button styling
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SolanaKeys | GPU Vanity Generator",
  description: "Distributed Hardware Vanity Address Generation Cluster",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body 
        className={`${geistSans.variable} ${geistMono.variable} min-h-full flex flex-col antialiased bg-background text-foreground transition-colors duration-300`}
        suppressHydrationWarning
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <WalletContextProvider>
            {children}
          </WalletContextProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}