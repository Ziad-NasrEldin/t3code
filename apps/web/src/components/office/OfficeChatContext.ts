import { createContext } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";

export const OfficeChatContext = createContext<{
  open: (ref: ScopedThreadRef) => void;
  close: () => void;
  isOpen: boolean;
}>({ open: () => {}, close: () => {}, isOpen: false });
