"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { describeApiError } from "@/lib/client/api";
import type { CatalogImportResult } from "@/lib/client/pro-api";
import { proApi } from "@/lib/client/pro-api";
import {
  IMPORT_COLUMNS_HELP, IMPORT_EXAMPLE, IMPORT_MAX_ROWS, IMPORT_PAGE_TITLE, PRO_PAGE_PATH, checkImportText, importSummary, rejectedRows,
} from "@/lib/client/pro-view";

/**
 * Import de catalogue par fichier CSV (droit de l'offre Pro) : le fichier est lu dans le navigateur (jamais stocké), un APERÇU à blanc montre ce qui serait créé ligne par ligne, puis
 * l'application crée les annonces. Rejouer le même fichier ne recrée rien.
 */
export function CatalogImportScreen() {
  const redirectIfUnauthorized = useUnauthorizedRedirect();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [pending, setPending] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogImportResult | null>(null);
  // Le résultat n'est valable que pour le texte qui l'a produit : un texte modifié efface l'aperçu (on n'applique jamais un fichier qu'on n'a pas prévisualisé).
  const [previewedText, setPreviewedText] = useState<string | null>(null);
  const submitting = useRef(false);

  const check = text.trim() === "" ? null : checkImportText(text);
  const previewValid = result !== null && result.mode === "preview" && previewedText === text;
  const canApply = previewValid && result.acceptedCount > 0 && !result.alreadyApplied && pending === null;

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    setPreviewedText(null);
    if (file.size > 256 * 1024) {
      setError("Le fichier dépasse 256 Ko : découpez-le en plusieurs fichiers.");
      return;
    }
    setText(await file.text());
    setFileName(file.name);
  };

  const run = async (dryRun: boolean) => {
    if (submitting.current) return;
    const verdict = checkImportText(text);
    if (!verdict.ok) {
      setError(verdict.message);
      return;
    }
    submitting.current = true;
    setPending(dryRun ? "preview" : "apply");
    setError(null);
    try {
      const next = await proApi.catalogImport.run({ csv: text, dryRun });
      setResult(next);
      setPreviewedText(dryRun ? text : null);
    } catch (failure) {
      if (redirectIfUnauthorized(failure)) return;
      setError(describeApiError(failure, "import"));
    } finally {
      submitting.current = false;
      setPending(null);
    }
  };

  const summary = result ? importSummary(result) : null;
  const rejected = result ? rejectedRows(result) : [];

  return (
    <main>
      <TopBar back="/vendeur/annonces" title={IMPORT_PAGE_TITLE} />
      <div className="px-4 pb-8">
        <p className="mt-3 text-[13px] text-ink-soft">
          Colonnes : {IMPORT_COLUMNS_HELP} {IMPORT_MAX_ROWS} lignes au plus par fichier. Votre fichier n&apos;est pas conservé : seules les annonces créées le sont.
        </p>
        <details className="mt-2 rounded-xl border border-line bg-white p-3 text-[12px] text-ink-soft">
          <summary className="cursor-pointer font-bold text-ink">Exemple de fichier</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{IMPORT_EXAMPLE}</pre>
        </details>

        <label className="mt-4 flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-forest/40 bg-white px-4 py-4 text-[14px] font-bold text-forest">
          <FileUp className="size-5" aria-hidden />
          {fileName ?? "Choisir un fichier CSV"}
          <input
            data-testid="import-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </label>
        <label htmlFor="import-text" className="mt-3 block text-[13px] font-bold text-ink">Ou collez le contenu du fichier</label>
        <textarea
          id="import-text"
          data-testid="import-text"
          value={text}
          onChange={(event) => { setText(event.target.value); setFileName(null); setError(null); }}
          rows={6}
          spellCheck={false}
          className="mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2.5 font-mono text-[12px] text-ink"
          placeholder={IMPORT_EXAMPLE}
        />
        {check && !check.ok ? <p role="alert" data-testid="import-check" className="mt-1.5 text-[13px] font-semibold text-carrot-ink">{check.message}</p> : null}

        <button
          data-testid="import-preview"
          onClick={() => void run(true)}
          disabled={pending !== null || check === null || !check.ok}
          className="mt-3 flex w-full items-center justify-center rounded-xl border border-forest/30 bg-white px-4 py-3 text-[14px] font-bold text-forest disabled:opacity-40"
        >
          {pending === "preview" ? "Aperçu en cours…" : "Aperçu (rien n'est créé)"}
        </button>
        <button
          data-testid="import-apply"
          onClick={() => void run(false)}
          disabled={!canApply}
          className="mt-2 flex w-full items-center justify-center rounded-xl bg-forest px-4 py-3 text-[14px] font-bold text-white disabled:opacity-40"
        >
          {pending === "apply" ? "Import en cours…" : "Importer et mettre en ligne"}
        </button>

        {error ? (
          <div role="alert" data-testid="import-error" className="mt-3 rounded-xl bg-carrot-soft p-3 text-[13px] font-semibold text-carrot-ink">
            {error}
            {error.includes("réservé à l'offre Pro") ? (
              <Link href={PRO_PAGE_PATH} className="mt-1 block underline">Voir l&apos;offre Pro</Link>
            ) : null}
          </div>
        ) : null}

        {result && summary ? (
          <section data-testid="import-report" data-mode={result.mode} data-replayed={summary.replayed ? "true" : "false"} className="mt-4 rounded-2xl border border-line bg-white p-4">
            <div className="text-[15px] font-extrabold text-ink">{summary.title}</div>
            <p data-testid="import-summary" className="mt-1 text-[13px] text-ink-soft">{summary.detail}</p>
            {rejected.length > 0 ? (
              <ul data-testid="import-rejected" className="mt-3 space-y-1.5" aria-label="Lignes refusées">
                {rejected.map((row) => (
                  <li key={row.line} data-line={row.line} className="rounded-lg bg-carrot-soft px-3 py-2 text-[12px] text-carrot-ink">
                    <strong>Ligne {row.line}</strong> : {row.text.replace(/^Ligne refusée : /, "")}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.mode === "apply" && result.acceptedCount > 0 ? (
              <Link href="/vendeur/annonces" data-testid="import-listings-link" className="mt-3 block text-[13px] font-bold text-forest underline">Voir mes annonces</Link>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
