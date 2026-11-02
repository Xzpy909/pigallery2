export interface EncryptionStatusDTO {
  /** the gallery has a key, new files are stored encrypted */
  enabled: boolean;
  /** the user whose login password protects the key (if enabled) */
  unlockUser: string | null;
  /** the user who asks: only this user can start the encryption the first time */
  currentUser: string;
  /** the minimum length of the password, it is the encryption key */
  minPasswordLength: number;
}
