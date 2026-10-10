/**
 * CLI view of the one user-owned folder trust store. The file and the
 * ancestor walk live in `src/utils/folder-trust-store.ts` so git hardening
 * reads the same record.
 */
export {
  folderPathKey,
  forgetFolderTrust,
  isFilesystemRoot,
  isFolderTrusted,
  listTrustedFolders,
  readTrustStore,
  rememberFolderTrust,
  trustStoreCovers,
  trustStorePath,
  writeTrustStore,
} from '../utils/folder-trust-store.js';
