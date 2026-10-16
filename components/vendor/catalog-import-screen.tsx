"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Eye, FileUp, Info, ListChecks, Loader2, Rocket, ShieldCheck } from "lucide-react";
import { ArtCheck } from "@/components/illustrations";
import { useUnauthorizedRedirect } from "@/components/session-gate";
import { TopBar } from "@/components/top-bar";
import { Textarea } from "@/components/ui";
import { BTN_OUTLINE, BTN_PRIMARY, LINK_ACTION, Notice } from "@/components/vendor/vendor-parts";
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
      <div className="flex flex-col gap-4 px-4 pb-8 pt-2">
        <Notice tone="info" icon={ShieldCheck} small>
          Colonnes : {IMPORT_COLUMNS_HELP} {IMPORT_MAX_ROWS} lignes au plus par fichier. Votre fichier n&apos;est pas conservé : seules les annonces créées le sont.
        </Notice>

        <details className="rounded-3xl border border-line bg-white p-4 text-[13px] text-ink-soft">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-[15px] font-bold text-ink">
            <Info className="size-5 text-brand" aria-hidden />
            Exemple de fichier
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-2xl bg-mist p-3 font-sans text-[13px] text-ink">{IMPORT_EXAMPLE}</pre>
        </details>

        <label className="press flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-brand/40 bg-brand-soft/50 px-4 py-6 text-center text-[16px] font-bold text-brand hover:bg-brand-soft">
          <FileUp className="size-9" aria-hidden />
          {fileName ?? "Choisir un fichier CSV"}
          <input
            data-testid="import-file"
            type="file"
            accept=".csv,text/csv,text/plain"
            className="sr-only"
            onChange={(event) => void readFile(event.target.files?.[0])}
          />
        </label>
        <div>
          <label htmlFor="import-text" className="mb-1.5 flex items-center gap-2 text-[14px] font-bold text-ink">
            <ListChecks className="size-4 shrink-0 text-brand" aria-hidden />
            Ou collez le contenu du fichier
          </label>
          <Textarea
            id="import-text"
            data-testid="import-text"
            value={text}
            onChange={(event) => { setText(event.target.value); setFileName(null); setError(null); }}
            rows={6}
            spellCheck={false}
            placeholder={IMPORT_EXAMPLE}
          />
          {check && !check.ok ? <p role="alert" data-testid="import-check" className="mt-1.5 text-[14px] font-semibold text-danger-ink">{check.message}</p> : null}
        </div>

        <div className="flex flex-col gap-2.5 md:flex-row md:[&>*]:flex-1">
          <button
            data-testid="import-preview"
            onClick={() => void run(true)}
            disabled={pending !== null || check === null || !check.ok}
            className={BTN_OUTLINE}
          >
            {pending === "preview" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Eye className="size-5" aria-hidden />}
            {pending === "preview" ? "Aperçu en cours…" : "Aperçu (rien n'est créé)"}
          </button>
          <button data-testid="import-apply" onClick={() => void run(false)} disabled={!canApply} className={BTN_PRIMARY}>
            {pending === "apply" ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Rocket className="size-5" aria-hidden />}
            {pending === "apply" ? "Import en cours…" : "Importer et mettre en ligne"}
          </button>
        </div>

        {error ? (
          <Notice tone="danger" role="alert" data-testid="import-error">
            {error}
            {error.includes("réservé à l'offre Pro") ? (
              <Link href={PRO_PAGE_PATH} className={`${LINK_ACTION} -ml-3 mt-1 underline`}>Voir l&apos;offre Pro</Link>
            ) : null}
          </Notice>
        ) : null}

        {result && summary ? (
          <section data-testid="import-report" data-mode={result.mode} data-replayed={summary.replayed ? "true" : "false"} className="animate-rise rounded-3xl border border-line bg-white p-5">
            <div className="flex items-center gap-3">
              <ArtCheck className="size-14 shrink-0" />
              <div className="min-w-0 flex-1 text-[17px] font-extrabold text-ink">{summary.title}</div>
            </div>
            <p data-testid="import-summary" className="mt-2 text-[14px] text-ink-soft">{summary.detail}</p>
            {rejected.length > 0 ? (
              <ul data-testid="import-rejected" className="mt-3 space-y-1.5" aria-label="Lignes refusées">
                {rejected.map((row) => (
                  <li key={row.line} data-line={row.line} className="rounded-2xl bg-danger-soft px-3.5 py-2.5 text-[13px] text-danger-ink">
                    <strong>Ligne {row.line}</strong> : {row.text.replace(/^Ligne refusée : /, "")}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.mode === "apply" && result.acceptedCount > 0 ? (
              <Link href="/vendeur/annonces" data-testid="import-listings-link" className={`${BTN_OUTLINE} mt-4`}>Voir mes annonces</Link>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
