# Code Context

## Summary
Plan proponuje trzy ulepszenia: eliminację zdublowanego zapisu `context.json` do `artifactsDir`, walidację `task` przed odpaleniem determinatora dla szybszego fail-fast, oraz scalenie `findContextFile` i `getStepContextFile` we wspólny helper redukujący duplikację logiki wyszukiwania plików kontekstowych.

## Files Retrieved
Plan nie zawiera konkretnych ścieżek — odniesienia do `chain-execution.ts:279-280,1079-1080` oraz `extension.ts` sugerują, że są to kluczowe pliki do zmian.

## Key Code
- `writeStepContextFile` — zapisuje `context.json` dwukrotnie (raz do `artifactsDir`, raz do `chainDir`)
- `loadContextFile` — czyta tylko z `chainDir`
- `JSON.parse(stepCtx.task)` — parsowanie taska w determinatorze, bez wcześniejszej walidacji schematu
- `findContextFile` / `getStepContextFile` — duplikacja logiki przeszukiwania katalogu po prefiksie `runId`

## Architecture
Przepływ: `extension.ts` → `writeStepContextFile` (zapis do 2 lokalizacji) → `loadContextFile` (odczyt z 1 lokalizacji) → child process determinatora parsuje `task`. Obie funkcje szukające plików kontekstowych są rozrzucone po kodzie zamiast w jednym helperze.

## Start Here
Otwórz `chain-execution.ts` w okolicach linii 279 i 1079, aby zrozumieć podwójny zapis `context.json`, oraz `extension.ts` aby znaleźć miejsce parsowania taska i obie funkcje wyszukiwania.
