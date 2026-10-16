/** Chaque changement de page arrive en fondu. Seul le contenu de la page est animé : la navigation reste en place. */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="animate-fade">{children}</div>;
}
