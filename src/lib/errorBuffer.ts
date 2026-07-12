/**
 * errorBuffer — ring buffer global dos últimos erros do frontend.
 *
 * Instalado no main.tsx (antes do app montar). Captura:
 *  - window "error" (exceções não tratadas, erros de script)
 *  - window "unhandledrejection" (promises rejeitadas)
 *  - console.error (wrap não-destrutivo)
 *
 * Consumido pelo report de melhorias (MelhoriaReportSheet): quando alguém
 * reporta um problema, os erros recentes vão juntos no context.extra —
 * "já pega o log do erro" sem o usuário fazer nada.
 */

export interface CapturedError {
  ts: string;                                      // ISO timestamp
  type: 'error' | 'promise' | 'console';
  message: string;
}

const MAX_ENTRIES = 20;
const MAX_MSG_LEN = 300;

const buffer: CapturedError[] = [];
let installed = false;

function push(type: CapturedError['type'], message: string) {
  const msg = String(message || '').slice(0, MAX_MSG_LEN);
  if (!msg) return;
  buffer.push({ ts: new Date().toISOString(), type, message: msg });
  if (buffer.length > MAX_ENTRIES) buffer.shift();
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function installErrorBuffer(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener('error', (e) => {
    push('error', `${e.message}${e.filename ? ` @ ${e.filename.split('/').pop()}:${e.lineno}` : ''}`);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    push('promise', reason instanceof Error ? `${reason.name}: ${reason.message}` : stringifyArg(reason));
  });

  const original = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    push('console', args.map(stringifyArg).join(' '));
    original(...args);
  };
}

/** Últimos erros capturados (mais antigo primeiro). */
export function getRecentErrors(): CapturedError[] {
  return [...buffer];
}
