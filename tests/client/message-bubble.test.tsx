import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "../../components/message-bubble";

/** Le texte d'un message est TOUJOURS du texte (lot D2) : un message qui ressemble à du HTML s'affiche tel quel, rien n'est interprété. */

const ROOT = join(import.meta.dirname, "../..");
function sources(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

describe("affichage d'un message", () => {
  test("du HTML dans un message est échappé : aucune balise, aucun gestionnaire d'événement ne sort du texte", () => {
    const body = `<img src=x onerror="alert(1)"><script>alert('x')</script><b>gras</b> &amp;`;
    const html = renderToStaticMarkup(<ul><MessageBubble message={{ id: 1, mine: false, body, createdAt: "2026-10-06T10:00:00.000Z" }} /></ul>);
    assert.ok(!html.includes("<img"), "aucune balise img");
    assert.ok(!html.includes("<script"), "aucune balise script");
    assert.ok(!html.includes("<b>"), "aucune balise b");
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"), "le texte est échappé, visible tel quel");
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("&amp;amp;"), "une entité n'est pas décodée");
  });

  test("marqué « mine » ou non, avec la date ; retours à la ligne conservés comme texte", () => {
    const mine = renderToStaticMarkup(<ul><MessageBubble message={{ id: 2, mine: true, body: "Bonjour", createdAt: "2026-10-06T10:00:00.000Z" }} /></ul>);
    assert.match(mine, /data-mine="true"/);
    assert.match(mine, /Bonjour/);
    assert.match(mine, /06\/10\/2026/);
    const theirs = renderToStaticMarkup(<ul><MessageBubble message={{ id: 3, mine: false, body: "Salut", createdAt: "2026-10-06T10:00:00.000Z" }} /></ul>);
    assert.match(theirs, /data-mine="false"/);
  });

  test("aucun dangerouslySetInnerHTML dans l'application (pages, composants)", () => {
    const offenders = [...sources("app"), ...sources("components")].filter((file) => /dangerouslySetInnerHTML\s*=|__html\s*:/.test(readFileSync(join(ROOT, file), "utf8")));
    assert.deepEqual(offenders, []);
  });

  test("l'écran de conversation n'affiche le texte que par MessageBubble (aucune insertion de HTML) et le texte du message n'est jamais construit en chaîne HTML", () => {
    const screen = readFileSync(join(ROOT, "components/conversation-screen.tsx"), "utf8");
    assert.match(screen, /<MessageBubble\b/);
    assert.ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(screen));
    const bubble = readFileSync(join(ROOT, "components/message-bubble.tsx"), "utf8");
    assert.ok(!/innerHTML/.test(bubble.replace(/\/\*[\s\S]*?\*\//g, "")));
  });
});
