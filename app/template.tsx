/** Chaque changement de page arrive en fondu et glisse légèrement vers le haut. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-rise">{children}</div>;
}
