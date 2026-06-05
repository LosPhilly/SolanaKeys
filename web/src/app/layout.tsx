import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { WalletContextProvider } from "@/components/WalletContextProvider";
import Script from "next/script";

// Fixes the broken wallet button styling
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SolanaKeys | GPU Vanity Generator",
  description: "Instantly generate custom Solana wallets. Zero-knowledge E2EE encryption, blistering GPU hash rates, and fully stateless deterministic key delivery.",
  metadataBase: new URL('https://solanakeys.com'),
  openGraph: {
    title: 'SolanaKeys | GPU Vanity Generator',
    description: 'Instantly generate custom Solana wallets. Zero-knowledge E2EE encryption, blistering GPU hash rates, and fully stateless deterministic key delivery.',
    url: 'https://solanakeys.com',
    siteName: 'SolanaKeys',
    images: [
      {
        url: '/images/solana-vanity-address-generator.jpg', // Pointing to your public file
        width: 1200,
        height: 630,
        alt: 'SolanaKeys GPU-accelerated vanity address generator',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'SolanaKeys | GPU Vanity Generator',
    description: 'Generate cryptographically secure, custom Solana vanity addresses at bare-metal speeds.',
    images: ['/images/solana-vanity-address-generator.jpg'], // Twitter also needs the path
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Google Analytics */}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-004DP1S90H"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-004DP1S90H');
          `}
        </Script>
      </head>
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
