import brandMarkUrl from "@/assets/branding/wa-studio-logo.svg";

interface BrandMarkProps {
  className?: string;
}

export function BrandMark({ className = "" }: BrandMarkProps) {
  return (
    <span aria-hidden="true" className={`workspace-brand-mark ${className}`.trim()}>
      <img alt="" src={brandMarkUrl} />
    </span>
  );
}
