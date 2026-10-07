import { ComingSoon } from "@/components/coming-soon";

export default function CommandeVendeurDetail() {
  return (
    <ComingSoon
      title="Détail d'une commande"
      sentence="Le suivi des commandes arrive bientôt."
      backHref="/vendeur"
      backLabel="Retour au tableau de bord"
    />
  );
}
