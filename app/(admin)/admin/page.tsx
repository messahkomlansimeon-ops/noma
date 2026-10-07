import { ComingSoon } from "@/components/coming-soon";

export default function Admin() {
  return (
    <ComingSoon
      title="Administration"
      sentence="L'espace d'administration arrive bientôt."
      backHref="/"
      backLabel="Retour à l'accueil"
    />
  );
}
