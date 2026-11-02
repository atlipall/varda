import { storageName } from '../channel';

/** Per-device preferences in localStorage; storage can be unavailable (private mode), so both
 *  sides fail soft to the default. */
export function readSetting(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(storageName(key));
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

/** A per-device choice among names (fails soft to `fallback`, as above). */
export function readChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(storageName(key));
    return choices.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeChoice(key: string, value: string): void {
  try {
    localStorage.setItem(storageName(key), value);
  } catch {
    // not remembered
  }
}

export function writeSetting(key: string, value: boolean): void {
  try {
    localStorage.setItem(storageName(key), value ? '1' : '0');
  } catch {
    // not remembered; the switch still works for this session
  }
}
