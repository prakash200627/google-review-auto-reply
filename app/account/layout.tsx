import type { ReactNode } from "react";
import { ModuleShell } from "@/components/nav/ModuleShell";

export default function AccountLayout({ children }: { children: ReactNode }) {
  return <ModuleShell module="account">{children}</ModuleShell>;
}
