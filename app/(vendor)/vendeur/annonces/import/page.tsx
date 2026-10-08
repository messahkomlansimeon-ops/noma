"use client";

import { SessionGate } from "@/components/session-gate";
import { CatalogImportScreen } from "@/components/vendor/catalog-import-screen";

export default function ImportCataloguePage() {
  return (
    <SessionGate>
      <CatalogImportScreen />
    </SessionGate>
  );
}
