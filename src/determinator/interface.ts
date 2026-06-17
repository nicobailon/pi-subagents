/**
 * DeterminatorScript — interfejs dla skryptów uruchamianych przez agenta "determinator".
 *
 * Każdy skrypt .ts podpinany do determinatora musi implementować ten interfejs:
 * eksportować domyślnie funkcję typu DeterminatorScript.
 */

export interface DeterminatorContext {
  /** Ścieżki wejściowe (z reads w chain stepie lub context.json) */
  inputs: string[];
  /** Ścieżka wyjściowa (z output w agencie/chain stepie) */
  output: string;
  /** Working directory */
  cwd: string;
  /** Oryginalny tekst zadania (po oczyszczeniu z prefixów) */
  task: string;
  /** Katalog chaina (z context.json.chain_dir), lub cwd jako fallback */
  chainDir: string;
  /** Dodatkowe parametry (z JSON-a w tasku, pole "params") */
  params: Record<string, unknown>;
  /** ID runa (PI_SUBAGENT_RUN_ID) */
  runId: string;
  /** Nazwa agenta (PI_SUBAGENT_CHILD_AGENT) */
  agentName: string;
  /** Indeks stepa (PI_SUBAGENT_CHILD_INDEX) */
  stepIndex: number;

  /** Loguj wiadomość (zapisuje do determinator-debug.log w chainDir) */
  log(message: string): void;

  /** Wykonaj komendę shella */
  exec(command: string): Promise<{ stdout: string; stderr: string }>;

  /** Odczytaj plik jako string */
  readFile(path: string): Promise<string>;

  /** Zapisz plik */
  writeFile(path: string, content: string): Promise<void>;
}

export interface DeterminatorResult {
  /** Kod wyjścia (0 = sukces) */
  exitCode: number;
  /** Tekst outputu */
  output: string;
  /** Opcjonalny komunikat błędu */
  error?: string;
}

export type DeterminatorScript = (
  ctx: DeterminatorContext,
) => Promise<DeterminatorResult>;
