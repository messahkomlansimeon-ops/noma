import { ComingSoon } from "@/components/coming-soon";

export default function Conversation() {
  return (
    <ComingSoon
      title="Conversation"
      sentence="La messagerie avec les vendeurs arrive bientôt. Pour le moment, le contact se fait par téléphone ou WhatsApp, depuis la fiche d'une annonce."
      backHref="/"
      backLabel="Retour à l'accueil"
    />
  );
}
