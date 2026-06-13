export interface CheckResult {
  name: string;
  ok: boolean;
  error?: string;
}

const SEPARATOR = '═══════════════════════════════════════';

export async function runCheck<T>(
  name: string,
  emoji: string,
  fn: () => Promise<T>,
  onSuccess: (result: T) => void
): Promise<CheckResult> {
  console.log(SEPARATOR);
  console.log(`${emoji} ${name}`);
  console.log(`${SEPARATOR}\n`);

  try {
    const result = await fn();
    onSuccess(result);
    return { name, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`❌ Error: ${message}\n`);
    return { name, ok: false, error: message };
  }
}
