import Link from "next/link";

export function Logo({ className = "h-6 w-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 40 28" fill="none" className={className} aria-hidden>
      <path
        d="M4 26 V13.5 C4 9 7.5 6 11.5 6 C15.5 6 19 9 19 13.5 V26"
        stroke="#0e5f3b"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M19 26 V13.5 C19 9 22.5 6 26.5 6 C30.5 6 34 9 34 13.5 V26"
        stroke="#0e5f3b"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="33.5" cy="4.5" r="3.5" fill="#f97316" />
    </svg>
  );
}

export function LogoMark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className="flex items-center gap-1.5">
      <Logo className={size === "lg" ? "h-9 w-13" : "h-6 w-9"} />
      <span
        className={`font-display font-extrabold tracking-tight text-forest ${
          size === "lg" ? "text-[28px]" : "text-[20px]"
        }`}
      >
        noma
      </span>
    </span>
  );
}

export function LogoLink() {
  return (
    <Link href="/" className="flex size-9 items-center hover:opacity-80">
      <LogoMark />
    </Link>
  );
}
