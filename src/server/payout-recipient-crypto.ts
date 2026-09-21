import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes
} from 'node:crypto';
import type { PayoutDestinationKind, PayoutRecipientType } from '../payout-destination';

type RecipientIdentity = {
  performerId: string;
  paymentMode: 'test' | 'live';
  destinationKind: PayoutDestinationKind;
  recipientType: PayoutRecipientType;
};

export type PayoutRecipientCipher = ReturnType<typeof createPayoutRecipientCipher>;

function associatedData(input: RecipientIdentity) {
  return Buffer.from(
    `sway-payout-recipient:v1:${input.performerId}:${input.paymentMode}:${input.destinationKind}:${input.recipientType}`,
    'utf8'
  );
}

export function createPayoutRecipientCipher(key: Buffer) {
  if (key.length !== 32) throw new Error('payout_recipient_encryption_key_must_be_32_bytes');
  const fingerprintKey = createHash('sha256')
    .update(key)
    .update('sway-payout-recipient-fingerprint-v1')
    .digest();

  function fingerprint(input: RecipientIdentity & { recipientValue: string }) {
    return createHmac('sha256', fingerprintKey)
      .update(associatedData(input))
      .update('\0')
      .update(input.recipientValue, 'utf8')
      .digest('hex');
  }

  return {
    fingerprint,

    encrypt(input: RecipientIdentity & { recipientValue: string }) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(associatedData(input));
      const ciphertext = Buffer.concat([
        cipher.update(input.recipientValue, 'utf8'),
        cipher.final()
      ]);
      const authTag = cipher.getAuthTag();
      const encryptedValue = [iv, authTag, ciphertext]
        .map((part) => part.toString('base64url'))
        .join('.');
      return { encryptedValue: `v1.${encryptedValue}`, fingerprint: fingerprint(input) };
    },

    decrypt(input: RecipientIdentity & { encryptedValue: string }) {
      const [version, ivEncoded, authTagEncoded, ciphertextEncoded, ...extra] = input.encryptedValue.split('.');
      if (version !== 'v1' || !ivEncoded || !authTagEncoded || !ciphertextEncoded || extra.length) {
        throw new Error('payout_recipient_ciphertext_invalid');
      }
      const iv = Buffer.from(ivEncoded, 'base64url');
      const authTag = Buffer.from(authTagEncoded, 'base64url');
      const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
      if (iv.length !== 12 || authTag.length !== 16 || ciphertext.length === 0) {
        throw new Error('payout_recipient_ciphertext_invalid');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(associatedData(input));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    }
  };
}

export function createConfiguredPayoutRecipientCipher(env: NodeJS.ProcessEnv = process.env) {
  const encodedKey = env.SWAY_PAYOUT_RECIPIENT_ENCRYPTION_KEY_BASE64?.trim();
  if (!encodedKey) return null;
  let key: Buffer;
  try {
    key = Buffer.from(encodedKey, 'base64');
  } catch {
    throw new Error('payout_recipient_encryption_key_invalid');
  }
  if (key.length !== 32 || key.toString('base64') !== encodedKey.replace(/\s+/g, '')) {
    throw new Error('payout_recipient_encryption_key_invalid');
  }
  return createPayoutRecipientCipher(key);
}
