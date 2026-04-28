import keytar from 'keytar';
import { KEYCHAIN_KEYS, KEYCHAIN_SERVICE } from '@shared/paths.js';

type KeyName = (typeof KEYCHAIN_KEYS)[keyof typeof KEYCHAIN_KEYS];

export async function getSecret(name: KeyName): Promise<string | null> {
  return keytar.getPassword(KEYCHAIN_SERVICE, name);
}

export async function setSecret(name: KeyName, value: string): Promise<void> {
  await keytar.setPassword(KEYCHAIN_SERVICE, name, value);
}

export async function deleteSecret(name: KeyName): Promise<void> {
  await keytar.deletePassword(KEYCHAIN_SERVICE, name);
}
