import type { Metadata } from "next";

export const metadata: Metadata = { title: "SMS campaigns — RapidDial" };

export default function SmsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
