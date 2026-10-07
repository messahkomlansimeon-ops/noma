import { ComingSoon } from "@/components/coming-soon";

export default function DemandeDetail() {
  return (
    <ComingSoon
      title="Demande d'un acheteur"
      sentence="Répondre directement aux demandes d'acheteurs arrive bientôt."
      backHref="/vendeur"
      backLabel="Retour au tableau de bord"
    />
  );
}
