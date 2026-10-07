import { ComingSoon } from "@/components/coming-soon";

export default function OffreMaquette() {
  return (
    <ComingSoon
      title="Fiche d'une offre"
      sentence="Cette maquette n'est pas ouverte. Pour voir une annonce, ouvrez-la depuis les résultats de l'un de vos besoins."
      backHref="/alertes"
      backLabel="Mes besoins"
    />
  );
}
