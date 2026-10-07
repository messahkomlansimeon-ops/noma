import { ComingSoon } from "@/components/coming-soon";

export default function DossierDetail() {
  return (
    <ComingSoon
      title="Dossier de modération"
      sentence="Le traitement des dossiers arrive bientôt."
      backHref="/admin"
      backLabel="Retour"
    />
  );
}
