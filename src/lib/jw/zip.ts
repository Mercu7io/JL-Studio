/**
 * Panda JL Studio — Zip Archiver & Extractor for .jwlibrary bundles
 * A .jwlibrary file is a standard ZIP archive containing:
 * - manifest.json
 * - userData.db
 * - optional extra files (e.g. default_thumbnail.png, IndependentMedia images/slides)
 */

import JSZip from 'jszip';
import type { IManifest } from './types.ts';
import { calculateSha256 } from './manifest.ts';

export interface IExtractedJwLibrary {
  manifest: IManifest;
  dbBytes: Uint8Array;
  fileName: string;
  fileSizeBytes: number;
  extraFiles: Map<string, Uint8Array>;
}

export interface IExtractProgress {
  stage: string;
  percent: number;
}

/**
 * Extracts userData.db, manifest.json, and all attached media files from a .jwlibrary file or blob.
 */
export async function extractJwLibrary(
  fileOrBlob: Blob | File | ArrayBuffer | Uint8Array,
  defaultName: string = 'backup.jwlibrary',
  onProgress?: (progress: IExtractProgress) => void
): Promise<IExtractedJwLibrary> {
  const fileName = fileOrBlob instanceof File ? fileOrBlob.name : defaultName;
  const fileSizeBytes =
    fileOrBlob instanceof ArrayBuffer
      ? fileOrBlob.byteLength
      : fileOrBlob instanceof Uint8Array
      ? fileOrBlob.byteLength
      : fileOrBlob.size;

  // Resilience: Check if this file is a raw unzipped SQLite database (e.g. from legacy upload)
  let isRawSqlite = false;
  let rawBytes: Uint8Array | null = null;
  if (fileOrBlob instanceof ArrayBuffer) {
    rawBytes = new Uint8Array(fileOrBlob);
    if (rawBytes.length >= 15 && String.fromCharCode(...rawBytes.slice(0, 15)) === 'SQLite format 3') {
      isRawSqlite = true;
    }
  } else if (fileOrBlob instanceof Uint8Array) {
    rawBytes = fileOrBlob;
    if (rawBytes.length >= 15 && String.fromCharCode(...rawBytes.slice(0, 15)) === 'SQLite format 3') {
      isRawSqlite = true;
    }
  } else if (typeof (fileOrBlob as Blob).slice === 'function') {
    try {
      const head = await (fileOrBlob as Blob).slice(0, 16).arrayBuffer();
      const headBytes = new Uint8Array(head);
      if (headBytes.length >= 15 && String.fromCharCode(...headBytes.slice(0, 15)) === 'SQLite format 3') {
        isRawSqlite = true;
        rawBytes = new Uint8Array(await (fileOrBlob as Blob).arrayBuffer());
      }
    } catch (_) {}
  }

  if (isRawSqlite && rawBytes) {
    onProgress?.({ stage: 'Recovering SQLite database...', percent: 50 });
    const hash = await calculateSha256(rawBytes);
    const cleanName = fileName.replace(/(\.jwlibrary|\.db|\.enc)$/i, '');
    const manifest: IManifest = {
      name: cleanName || 'userData',
      creationDate: new Date().toISOString(),
      userDataBackupVersion: 1,
      deviceName: 'Recovered SQLite Database',
      version: 1,
      type: 0,
      userDataBackup: {
        lastModifiedDate: new Date().toISOString(),
        deviceName: 'Recovered SQLite Database',
        databaseName: 'userData.db',
        hash,
        schemaVersion: 14,
      },
    };
    onProgress?.({ stage: 'Unpack complete', percent: 100 });
    return {
      manifest,
      dbBytes: rawBytes,
      fileName,
      fileSizeBytes: rawBytes.byteLength,
      extraFiles: new Map(),
    };
  }

  onProgress?.({ stage: 'Unpacking archive...', percent: 10 });
  const zip = new JSZip();
  const dataToLoad =
    typeof (fileOrBlob as Blob).arrayBuffer === 'function'
      ? await (fileOrBlob as Blob).arrayBuffer()
      : fileOrBlob;
  const loadedZip = await zip.loadAsync(dataToLoad);

  onProgress?.({ stage: 'Reading manifest.json...', percent: 25 });
  // Read manifest.json
  const manifestFile = loadedZip.file('manifest.json');
  if (!manifestFile) {
    throw new Error(
      'Invalid .jwlibrary archive: "manifest.json" not found in the backup root.'
    );
  }
  const manifestText = await manifestFile.async('text');
  let manifest: IManifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (err) {
    throw new Error('Failed to parse manifest.json: ' + (err as Error).message);
  }

  // Find database (normally userData.db, or specified by manifest)
  const dbName = manifest.userDataBackup?.databaseName || 'userData.db';
  const dbFile = loadedZip.file(dbName) || loadedZip.file('userData.db');
  if (!dbFile) {
    throw new Error(
      `Invalid .jwlibrary archive: database file "${dbName}" not found.`
    );
  }

  onProgress?.({ stage: 'Extracting database...', percent: 35 });
  const dbBytes = await dbFile.async('uint8array', (metadata) => {
    const p = Math.min(80, Math.round(35 + (metadata.percent * 0.45)));
    onProgress?.({ stage: 'Extracting database...', percent: p });
  });

  // Preserve any extra files (thumbnails, user images, slides)
  const extraFiles = new Map<string, Uint8Array>();
  const extraFileEntries = Object.entries(loadedZip.files).filter(
    ([relativePath, zipEntry]) =>
      !zipEntry.dir &&
      relativePath !== 'manifest.json' &&
      relativePath !== dbName &&
      relativePath !== 'userData.db'
  );

  let processedCount = 0;
  for (const [relativePath, zipEntry] of extraFileEntries) {
    const bytes = await zipEntry.async('uint8array');
    extraFiles.set(relativePath, bytes);
    processedCount++;
    const p = Math.min(95, Math.round(80 + (processedCount / (extraFileEntries.length || 1)) * 15));
    onProgress?.({ stage: 'Extracting media attachments...', percent: p });
  }

  onProgress?.({ stage: 'Unpack complete', percent: 95 });

  return {
    manifest,
    dbBytes,
    fileName,
    fileSizeBytes,
    extraFiles,
  };
}

/**
 * Packages userData.db, manifest.json, and any extra media files into a downloadable .jwlibrary Blob.
 * Automatically verifies and stamps the SHA-256 hash in manifest.json.
 */
export async function packageJwLibrary(
  dbBytes: Uint8Array,
  manifest: IManifest,
  extraFiles?: Map<string, Uint8Array>,
  onProgress?: (percent: number) => void
): Promise<Blob> {
  // Ensure hash matches the exact dbBytes being zipped
  const hash = await calculateSha256(dbBytes);
  const updatedManifest: IManifest = {
    ...manifest,
    userDataBackup: {
      ...manifest.userDataBackup,
      hash,
      databaseName: 'userData.db',
    },
  };

  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(updatedManifest, null, 2));
  zip.file('userData.db', dbBytes);

  // Re-attach extra media files if present
  if (extraFiles) {
    for (const [filePath, fileData] of extraFiles.entries()) {
      zip.file(filePath, fileData);
    }
  }

  return await zip.generateAsync(
    {
      type: 'blob',
      mimeType: 'application/octet-stream',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      onProgress?.(metadata.percent);
    }
  );
}
