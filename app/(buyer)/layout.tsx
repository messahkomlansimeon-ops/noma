import { RoleSwitcher } from "@/components/role-switcher";
import { BuyerTabBar } from "@/components/tab-bar";

/** Téléphone : colonne unique et barre en bas. À partir de 768 px : menu latéral et contenu centré, plus large. */
export default function BuyerLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="min-h-dvh md:grid md:grid-cols-[17rem_minmax(0,1fr)]">
      <BuyerTabBar />
      <div className="flex min-w-0 flex-col">
        <RoleSwitcher />
        <div className="mx-auto w-full max-w-3xl flex-1 pb-28 md:pb-12">{children}</div>
      </div>
    </div>
  );
}
