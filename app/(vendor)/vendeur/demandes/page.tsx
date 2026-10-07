import { ComingSoon } from "@/components/coming-soon";

export default function Demandes() {
  return (
    <ComingSoon
      title="Demandes d'acheteurs"
      sentence="Répondre directement aux demandes d'acheteurs arrive bientôt. Pour le moment, voyez sur chaque annonce combien de besoins y correspondent."
      backHref="/vendeur"
      backLabel="Retour au tableau de bord"
    />
  );
}
