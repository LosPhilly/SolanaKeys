declare module 'tweetnacl-sealedbox-js' {
  /**
   * Encrypt a message using a public key.
   * @param message The message to encrypt (Uint8Array)
   * @param publicKey The recipient's Curve25519 public key (Uint8Array)
   * @returns The encrypted ciphertext (Uint8Array)
   */
  export function seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;

  /**
   * Decrypt a ciphertext using a keypair.
   * @param ciphertext The encrypted message (Uint8Array)
   * @param publicKey The recipient's Curve25519 public key (Uint8Array)
   * @param secretKey The recipient's Curve25519 secret key (Uint8Array)
   * @returns The decrypted message, or null if decryption fails (Uint8Array | null)
   */
  export function open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    secretKey: Uint8Array
  ): Uint8Array | null;
}