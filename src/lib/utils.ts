import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Aceternity/shadcn class composition helper. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
