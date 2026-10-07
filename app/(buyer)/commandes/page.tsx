import { ComingSoon } from "@/components/coming-soon";

export default function Commandes() {
  return (
    <ComingSoon
      title="Mes commandes"
      sentence="Le suivi de vos commandes arrive bientôt."
      backHref="/compte"
      backLabel="Retour au compte"
    />
  );
}
