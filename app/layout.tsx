import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'HomeScout – AI property search',
  description: 'Ask for Dubai homes in plain English. An LLM agent searches sample listings with tool calling.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
