import { ComingSoon } from "@/components/coming-soon";

export default function CommandesVendeur() {
  return (
    <ComingSoon
      title="Commandes"
      sentence="Le suivi des commandes arrive bientôt."
      backHref="/vendeur"
      backLabel="Retour au tableau de bord"
    />
  );
}
