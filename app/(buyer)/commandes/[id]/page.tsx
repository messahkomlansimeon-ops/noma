import { ComingSoon } from "@/components/coming-soon";

export default function CommandeDetail() {
  return (
    <ComingSoon
      title="Détail d'une commande"
      sentence="Le suivi de vos commandes arrive bientôt."
      backHref="/compte"
      backLabel="Retour au compte"
    />
  );
}
