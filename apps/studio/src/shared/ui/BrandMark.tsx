import brandMarkUrl from "@/assets/branding/wa-studio-logo.svg?no-inline";
import "./brand-mark.css";

interface BrandMarkProps {
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function BrandMark({ className = "", size = "md" }: BrandMarkProps) {
  return (
    <span aria-hidden="true" className={`brand-mark brand-mark-${size} ${className}`.trim()}>
      <img alt="" src={brandMarkUrl} />
    </span>
  );
}
