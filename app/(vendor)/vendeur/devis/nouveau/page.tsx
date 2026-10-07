import { ComingSoon } from "@/components/coming-soon";

export default function DevisNouveau() {
  return (
    <ComingSoon
      title="Nouveau devis"
      sentence="Envoyer un devis à un acheteur arrive bientôt."
      backHref="/vendeur"
      backLabel="Retour au tableau de bord"
    />
  );
}
