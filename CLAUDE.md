# inforeqapp – CLAUDE.md

Webová aplikace pro správu informačních požadavků (klasifikace, objekty, fáze, číselníky IFC) s importem/exportem do **IDS** (buildingSMART Information Delivery Specification) a do Excelu.

> Nezmapované části jsou označeny `TODO`. Doplňte je, nebo je nechte vyplnit Claude Code.

## Stack
- React 18 + TypeScript (~5.9) + Vite 7, Tailwind CSS 3
- Knihovny: `exceljs` (Excel import/export), `jszip`, `idb-keyval` (lokální úložiště v prohlížeči), `@tanstack/react-virtual` (velké seznamy), `fast-xml-parser` (IDS/XSD/XML)
- Skripty běží přes `tsx` / `node`
- Nasazení: Vercel (viz `docs/VERCEL_DEPLOY.md`)

## Příkazy
- `npm run dev` – před startem spustí `ensure:schema` a `sync:translations`, pak Vite
- `npm run build` – `tsc && vite build` (typová kontrola je součástí buildu)
- `npm run build:schema` (`:4`, `:all`) – generuje index schématu IFC 4x3 / IFC4 z `IFC/`
- `npm run build:deprecated` – seznam deprecated IFC entit
- `npm run generate:ifc4-dictionary` – slovník IFC4
- `npm run sync:translations` – synchronizace překladů
- `npm run sync:img` – kopie `img/` do `public/img`
- Testy: `TODO` (v repozitáři je jen `test_desc.ts`, žádný test runner)

## Struktura
- `src/classification/` – klasifikační systémy, parser, strom IFC, hierarchie
- `src/project/` – jádro domény: typy, fáze, autorování požadavků, filtry požadavků (`requestFilter*`), enumerace, migrace dat, úložiště (`storage.ts`), `useCaseResolve`
- `src/import/`, `src/export/` – Excel a **IDS** (`ids.ts`), číselníky
- `src/schema/` – verze IFC a `SchemaProvider`
- `src/translation/` – překladová vrstva (BSDD, Excel, kontext)
- `src/ui/components/` – React komponenty (dialogy, editory, panely)
- `scripts/` – buildovací a analytické skripty (ne runtime kód)
- `IDS/` – `ids.xsd`, `DataTypes.md`, `tolerance.md`, `developer-guide.md` (referenční materiály k IDS)
- `IFC/` – zdrojová schémata IFC (EXPRESS, pSet XSD). **Velké, generované vstupy – nečíst celé, nezasahovat.**
- `Vzorové soubory/`, `Archiv/`, `public/*.xlsx` – vzorová a historická data, ne zdrojový kód
- `docs/architecture/` – architektura (overview, modules, data-flows, schema-and-version, sensitive-areas, glossary)
- `docs/navod/` – uživatelský návod

Před většími změnami si přečtěte `docs/architecture/overview.md`, `modules.md` a hlavně **`sensitive-areas.md`**. Stav práce a další kroky: `docs/architecture/STAV_A_DALSI_KROKY.md`.

## Konvence
- Jazyk uživatelského rozhraní a dokumentace: čeština (překlady řeší `src/translation/`).
- Doménová logika patří do `src/project/`, `src/import`, `src/export`; komponenty v `src/ui/` zůstávají tenké.
- Změny datového modelu vždy provázet migrací v `src/project/migration.ts` (data jsou uložena lokálně v prohlížeči přes IndexedDB).
- IDS export musí odpovídat `IDS/ids.xsd` a poznámkám v `IDS/developer-guide.md`.
- Bez `any`, pokud to není nevyhnutelné; `npm run build` musí projít.
- `TODO`: styl kódu / lint (v `package.json` není ESLint ani Prettier).

## Pravidla pro práci
- Nečíst ani neprocházet `IFC/`, `Archiv/`, `Vzorové soubory/`, `node_modules/`, `dist/` bez konkrétního důvodu.
- Neupravovat generované soubory (index schématu, slovníky) ručně – použít odpovídající `npm run build:*`.
- Před úpravou importu/exportu a migrací ověřit dopad na existující uložená data.
- Po dokončení změny spustit `npm run build`.

## Stav práce
- Verze aplikace: 1.0.2 (viz `docs/RELEASE.md`)
- `TODO`: hotovo / rozpracováno / známé problémy
