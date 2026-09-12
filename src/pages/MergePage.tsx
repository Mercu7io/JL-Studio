import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  GitMerge,
  Upload,
  CheckCircle2,
  Download,
  Compass,
  FileText,
  Cloud,
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Check,
  Smartphone,
  Tablet,
  X,
  RefreshCw,
  RotateCcw,
  Loader2,
  Sliders,
  Tag,
  ChevronDown,
  Copy,
  Highlighter,
  Bookmark,
  ListMusic,
  ListFilter,
  AlertCircle,
  Database,
  Lock,
  WifiOff,
} from 'lucide-react';
import { extractJwLibrary } from '../lib/jw/zip';
import { openDatabase, getLibrarySummary, queryAll } from '../lib/jw/sqlite';
import { computeSha256 } from '../lib/jw/hash';
import { mergeJwLibraries, IMergeResult, getDefaultMergeFilename } from '../lib/jw/merge';
import { IManifest, ILibrarySummary, IMergeProgress, TagManagerMap, IMergeDetailedNote } from '../lib/jw/types';
import { detectRealConflicts, IConflictItem } from '../lib/jw/conflicts';
import { MergeDetailedBreakdown } from '../components/merge/MergeDetailedBreakdown';
import { useAppStore } from '../store/useAppStore';
import { useCloudStore } from '../store/useCloudStore';
import { IDriveFile } from '../lib/cloud/googleDrive';
import { useTranslation } from 'react-i18next';

const HIGHLIGHT_COLOR_MAP: Record<number, { bg: string; name: string; border: string }> = {
  1: { bg: 'bg-yellow-400', border: 'border-yellow-500', name: 'Yellow' },
  2: { bg: 'bg-emerald-500', border: 'border-emerald-600', name: 'Green' },
  3: { bg: 'bg-blue-500', border: 'border-blue-600', name: 'Blue' },
  4: { bg: 'bg-pink-500', border: 'border-pink-600', name: 'Pink' },
  5: { bg: 'bg-orange-500', border: 'border-orange-600', name: 'Orange' },
  6: { bg: 'bg-purple-500', border: 'border-purple-600', name: 'Purple' },
};

interface ILoadedFileState {
  file: File;
  dbBytes: Uint8Array;
  manifest: IManifest;
  summary: ILibrarySummary;
  extraFiles: Map<string, Uint8Array>;
  sha256: string;
}

export const MergePage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    activeLibraryFile,
    activeLibraryBytes,
    activeManifest,
    activeSha256,
    extraFiles,
    summary: activeSummary,
    updateActiveDatabase,
    setIsLoading: setAppIsLoading,
  } = useAppStore();
  const {
    isConnected,
    isOnline,
    backups,
    refreshBackups,
    connect,
    downloadCloudFile,
    backupCurrentLibrary,
    backupFileDirectly,
    isShaInCloud,
    isUploading,
    uploadProgress,
    encryptionPassword,
    setEncryptionConfig,
    cachedEncryptedDownload,
  } = useCloudStore();

  const [primaryFile, setPrimaryFile] = useState<ILoadedFileState | null>(null);
  const [secondaryFile, setSecondaryFile] = useState<ILoadedFileState | null>(null);
  const [isLoadingPrimary, setIsLoadingPrimary] = useState<boolean>(false);
  const [isLoadingSecondary, setIsLoadingSecondary] = useState<boolean>(false);
  const [primaryProgress, setPrimaryProgress] = useState<{ stage: string; percent: number } | null>(null);
  const [secondaryProgress, setSecondaryProgress] = useState<{ stage: string; percent: number } | null>(null);
  const [isOpenInAppLoading, setIsOpenInAppLoading] = useState<boolean>(false);
  const [isLoadingAppPrimary, setIsLoadingAppPrimary] = useState<boolean>(false);
  const [isLoadingAppSecondary, setIsLoadingAppSecondary] = useState<boolean>(false);
  const [isUploadingPrimary, setIsUploadingPrimary] = useState<boolean>(false);
  const [isUploadingSecondary, setIsUploadingSecondary] = useState<boolean>(false);
  const [uploadProgressPrimary, setUploadProgressPrimary] = useState<number | null>(null);
  const [uploadProgressSecondary, setUploadProgressSecondary] = useState<number | null>(null);
  const [isUploadingMerged, setIsUploadingMerged] = useState<boolean>(false);
  const [uploadProgressMerged, setUploadProgressMerged] = useState<number | null>(null);
  const [isDraggingPrimary, setIsDraggingPrimary] = useState<boolean>(false);
  const [isDraggingSecondary, setIsDraggingSecondary] = useState<boolean>(false);
  const [outputName, setOutputName] = useState<string>(getDefaultMergeFilename());

  // Conflict Resolution State
  const [conflicts, setConflicts] = useState<IConflictItem[]>([]);

  // Tag imported notes option
  const [tagImportedNotes, setTagImportedNotes] = useState<boolean>(false);
  const [customImportTagName, setCustomImportTagName] = useState<string>('From Merge');

  // Cloud Picker State
  const [cloudPickerTarget, setCloudPickerTarget] = useState<'primary' | 'secondary' | null>(null);
  const [isDownloadingCloud, setIsDownloadingCloud] = useState<boolean>(false);
  const [cloudDownloadProgress, setCloudDownloadProgress] = useState<number | null>(null);
  const [cloudPasswordPromptFile, setCloudPasswordPromptFile] = useState<IDriveFile | null>(null);
  const [cloudPasswordInput, setCloudPasswordInput] = useState<string>('');
  const [cloudPasswordError, setCloudPasswordError] = useState<string | null>(null);
  const [isVerifyingPassword, setIsVerifyingPassword] = useState<boolean>(false);
  const [passwordAttemptCount, setPasswordAttemptCount] = useState<number>(0);

  // In-Memory Library Presence & Label formatting
  const hasActiveInMemory = !!(activeLibraryBytes && activeManifest && activeSummary);
  const inMemoryShortName = activeSummary?.deviceName
    ? activeSummary.deviceName.length > 14
      ? activeSummary.deviceName.slice(0, 13) + '…'
      : activeSummary.deviceName
    : activeSummary?.name
    ? activeSummary.name.length > 14
      ? activeSummary.name.slice(0, 13) + '…'
      : activeSummary.name
    : 'In-Memory';

  const handleUseInMemory = (target: 'primary' | 'secondary') => {
    if (!activeLibraryBytes || !activeManifest || !activeSummary) return;
    const fileObj =
      (activeLibraryFile as File) ||
      new File([activeLibraryBytes as unknown as BlobPart], activeSummary.name || 'in_memory_backup.jwlibrary', {
        type: 'application/zip',
      });
    const loadedState: ILoadedFileState = {
      file: fileObj,
      dbBytes: activeLibraryBytes,
      manifest: activeManifest,
      extraFiles: extraFiles || new Map(),
      summary: activeSummary,
      sha256: activeSha256 || '',
    };
    if (target === 'primary') {
      setPrimaryFile(loadedState);
      setPrimaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
    } else {
      setSecondaryFile(loadedState);
      setSecondaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
    }
  };

  const [isMerging, setIsMerging] = useState<boolean>(false);
  const [mergeProgress, setMergeProgress] = useState<IMergeProgress | null>(null);
  const [mergeResult, setMergeResult] = useState<IMergeResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cloudSaveSuccess, setCloudSaveSuccess] = useState<boolean>(false);

  // Detailed View, Exclusion & Override State
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [candidateNotes, setCandidateNotes] = useState<IMergeDetailedNote[]>([]);
  const [candidateDuplicates, setCandidateDuplicates] = useState<IMergeDetailedNote[]>([]);
  const [excludedNoteGuids, setExcludedNoteGuids] = useState<Set<string>>(new Set());
  const [lastMergedExcludedGuids, setLastMergedExcludedGuids] = useState<Set<string>>(new Set());
  const [noteOverrides, setNoteOverrides] = useState<Record<string, { title?: string; content?: string }>>({});
  const [lastMergedNoteOverrides, setLastMergedNoteOverrides] = useState<Record<string, { title?: string; content?: string }>>({});

  const toggleNoteExclusion = (guid: string) => {
    setExcludedNoteGuids((prev) => {
      const next = new Set(prev);
      if (next.has(guid)) {
        next.delete(guid);
      } else {
        next.add(guid);
      }
      return next;
    });
  };

  const handleSetNoteOverride = (guid: string, override: { title?: string; content?: string } | null) => {
    setNoteOverrides((prev) => {
      const next = { ...prev };
      if (!override) {
        delete next[guid];
      } else {
        next[guid] = override;
      }
      return next;
    });
  };

  const hasUnsavedExclusionChanges =
    excludedNoteGuids.size !== lastMergedExcludedGuids.size ||
    Array.from(excludedNoteGuids).some((g) => !lastMergedExcludedGuids.has(g)) ||
    JSON.stringify(noteOverrides) !== JSON.stringify(lastMergedNoteOverrides);

  const primaryInputRef = useRef<HTMLInputElement>(null);
  const secondaryInputRef = useRef<HTMLInputElement>(null);
  const primaryLoadingRef = useRef<boolean>(false);
  const secondaryLoadingRef = useRef<boolean>(false);
  const resultRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to success result when merge completes
  useEffect(() => {
    if (mergeResult) {
      resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [mergeResult]);

  // Check if preloaded from CloudSyncModal
  useEffect(() => {
    const preloaded = (window as any).__PANDA_PRELOAD_MERGE__;
    if (preloaded?.primary && preloaded?.secondary) {
      (async () => {
        try {
          await loadPrimary(preloaded.primary);
          await loadSecondary(preloaded.secondary);
          delete (window as any).__PANDA_PRELOAD_MERGE__;
        } catch (err) {
          setErrorMessage('Failed to load pre-selected cloud files: ' + (err as Error).message);
        }
      })();
    }
  }, []);

  const loadPrimary = async (file: File) => {
    try {
      primaryLoadingRef.current = true;
      setIsLoadingPrimary(true);
      setPrimaryProgress({ stage: t('merge.progressUnpacking', 'Unpacking backup archive...'), percent: 10 });
      setAppIsLoading(true, t('merge.loadingSourceA', 'Loading Source A into app...'));
      setErrorMessage(null);
      setMergeResult(null);
      setCandidateNotes([]);
      setExcludedNoteGuids(new Set());
      setLastMergedExcludedGuids(new Set());
      setShowDetails(false);

      const { manifest, dbBytes, fileSizeBytes, extraFiles } = await extractJwLibrary(
        file,
        file.name,
        (p) => {
          setPrimaryProgress(p);
          setAppIsLoading(true, `${p.stage} (${p.percent}%)`);
        }
      );

      setPrimaryProgress({ stage: t('merge.progressSqlite', 'Analyzing SQLite database...'), percent: 96 });
      setAppIsLoading(true, `${t('merge.progressSqlite', 'Analyzing SQLite database...')} (96%)`);
      const db = await openDatabase(dbBytes);
      const summary = getLibrarySummary(db, manifest, fileSizeBytes);
      db.close();

      setPrimaryProgress({ stage: t('merge.progressChecksum', 'Verifying integrity hash...'), percent: 98 });
      setAppIsLoading(true, `${t('merge.progressChecksum', 'Verifying integrity hash...')} (98%)`);
      const sha256 = await computeSha256(dbBytes);

      setPrimaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
      setPrimaryFile({ file, dbBytes, manifest, summary, extraFiles, sha256 });
    } catch (err: any) {
      console.error('Error loading Source A:', err);
      setErrorMessage(t('merge.loadPrimaryError', 'Failed to load Source A: ') + (err?.message || String(err)));
    } finally {
      primaryLoadingRef.current = false;
      setIsLoadingPrimary(false);
      setPrimaryProgress(null);
      if (!secondaryLoadingRef.current) {
        setAppIsLoading(false);
      }
    }
  };

  const loadSecondary = async (file: File) => {
    try {
      secondaryLoadingRef.current = true;
      setIsLoadingSecondary(true);
      setSecondaryProgress({ stage: t('merge.progressUnpacking', 'Unpacking backup archive...'), percent: 10 });
      setAppIsLoading(true, t('merge.loadingSourceB', 'Loading Source B into app...'));
      setErrorMessage(null);
      setMergeResult(null);
      setCandidateNotes([]);
      setExcludedNoteGuids(new Set());
      setLastMergedExcludedGuids(new Set());
      setShowDetails(false);

      const { manifest, dbBytes, fileSizeBytes, extraFiles } = await extractJwLibrary(
        file,
        file.name,
        (p) => {
          setSecondaryProgress(p);
          setAppIsLoading(true, `${p.stage} (${p.percent}%)`);
        }
      );

      setSecondaryProgress({ stage: t('merge.progressSqlite', 'Analyzing SQLite database...'), percent: 96 });
      setAppIsLoading(true, `${t('merge.progressSqlite', 'Analyzing SQLite database...')} (96%)`);
      const db = await openDatabase(dbBytes);
      const summary = getLibrarySummary(db, manifest, fileSizeBytes);
      db.close();

      setSecondaryProgress({ stage: t('merge.progressChecksum', 'Verifying integrity hash...'), percent: 98 });
      setAppIsLoading(true, `${t('merge.progressChecksum', 'Verifying integrity hash...')} (98%)`);
      const sha256 = await computeSha256(dbBytes);

      setSecondaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
      setSecondaryFile({ file, dbBytes, manifest, summary, extraFiles, sha256 });
    } catch (err: any) {
      console.error('Error loading Source B:', err);
      setErrorMessage(t('merge.loadSecondaryError', 'Failed to load Source B: ') + (err?.message || String(err)));
    } finally {
      secondaryLoadingRef.current = false;
      setIsLoadingSecondary(false);
      setSecondaryProgress(null);
      if (!primaryLoadingRef.current) {
        setAppIsLoading(false);
      }
    }
  };

  const handleLoadPrimaryIntoApp = async () => {
    if (!primaryFile) return;
    try {
      setIsLoadingAppPrimary(true);
      await updateActiveDatabase(primaryFile.dbBytes, primaryFile.manifest, primaryFile.extraFiles, primaryFile.file);
      navigate('/explorer');
    } catch (err: any) {
      setErrorMessage(t('merge.loadPrimaryError', 'Failed to load into app: ') + (err?.message || String(err)));
    } finally {
      setIsLoadingAppPrimary(false);
    }
  };

  const handleLoadSecondaryIntoApp = async () => {
    if (!secondaryFile) return;
    try {
      setIsLoadingAppSecondary(true);
      await updateActiveDatabase(secondaryFile.dbBytes, secondaryFile.manifest, secondaryFile.extraFiles, secondaryFile.file);
      navigate('/explorer');
    } catch (err: any) {
      setErrorMessage(t('merge.loadSecondaryError', 'Failed to load into app: ') + (err?.message || String(err)));
    } finally {
      setIsLoadingAppSecondary(false);
    }
  };

  const handleResetMerge = () => {
    setPrimaryFile(null);
    setSecondaryFile(null);
    setPrimaryProgress(null);
    setSecondaryProgress(null);
    setConflicts([]);
    setMergeProgress(null);
    setMergeResult(null);
    setErrorMessage(null);
    setCloudSaveSuccess(false);
    setShowDetails(false);
    setCandidateNotes([]);
    setCandidateDuplicates([]);
    setExcludedNoteGuids(new Set());
    setLastMergedExcludedGuids(new Set());
    setNoteOverrides({});
    setLastMergedNoteOverrides({});
    setTagImportedNotes(false);
    setCustomImportTagName('From Merge');
    setOutputName(getDefaultMergeFilename());
    setUploadProgressPrimary(null);
    setUploadProgressSecondary(null);
    setIsUploadingMerged(false);
    setUploadProgressMerged(null);
    if (primaryInputRef.current) primaryInputRef.current.value = '';
    if (secondaryInputRef.current) secondaryInputRef.current.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleUploadPrimaryToCloud = async () => {
    if (!primaryFile) return;
    try {
      setIsUploadingPrimary(true);
      setUploadProgressPrimary(0);
      await backupFileDirectly(
        primaryFile.file,
        primaryFile.file.name,
        primaryFile.sha256,
        (percent) => setUploadProgressPrimary(percent),
        primaryFile.summary
      );
    } catch (err: any) {
      setErrorMessage(t('cloud.uploadError', 'Cloud upload error: ') + (err?.message || String(err)));
    } finally {
      setIsUploadingPrimary(false);
      setUploadProgressPrimary(null);
    }
  };

  const handleUploadSecondaryToCloud = async () => {
    if (!secondaryFile) return;
    try {
      setIsUploadingSecondary(true);
      setUploadProgressSecondary(0);
      await backupFileDirectly(
        secondaryFile.file,
        secondaryFile.file.name,
        secondaryFile.sha256,
        (percent) => setUploadProgressSecondary(percent),
        secondaryFile.summary
      );
    } catch (err: any) {
      setErrorMessage(t('cloud.uploadError', 'Cloud upload error: ') + (err?.message || String(err)));
    } finally {
      setIsUploadingSecondary(false);
      setUploadProgressSecondary(null);
    }
  };

  // Inspect Potential Conflicts when both files are loaded
  useEffect(() => {
    if (!primaryFile || !secondaryFile) {
      setConflicts([]);
      return;
    }

    (async () => {
      try {
        const dbA = await openDatabase(primaryFile.dbBytes);
        const dbB = await openDatabase(secondaryFile.dbBytes);

        const detected = detectRealConflicts(dbA, dbB);

        dbA.close();
        dbB.close();

        setConflicts(detected);
      } catch (_) {}
    })();
  }, [primaryFile, secondaryFile]);

  const handlePrimaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await loadPrimary(file);
    if (e.target) e.target.value = '';
  };

  const handleSecondaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) await loadSecondary(file);
    if (e.target) e.target.value = '';
  };

  const handleLoadDemoFiles = async () => {
    try {
      setErrorMessage(null);
      const [res1, res2] = await Promise.all([
        fetch('/example.jwlibrary'),
        fetch('/example2.jwlibrary'),
      ]);
      if (!res1.ok || !res2.ok) throw new Error('Could not fetch demo files');
      const [blob1, blob2] = await Promise.all([res1.blob(), res2.blob()]);

      const f1 = new File([blob1], 'Galaxy_Tab_Study.jwlibrary', { type: 'application/zip' });
      const f2 = new File([blob2], 'Pixel_Phone_Prep.jwlibrary', { type: 'application/zip' });

      await loadPrimary(f1);
      await loadSecondary(f2);
    } catch (err) {
      setErrorMessage('Could not load demo pair: ' + (err as Error).message);
    }
  };

  const handlePickFromCloud = async (target: 'primary' | 'secondary') => {
    if (!isConnected) {
      connect();
      return;
    }
    await refreshBackups();
    setCloudPickerTarget(target);
  };

  const handleSelectCloudBackup = async (b: IDriveFile, overridePass?: string) => {
    if (!cloudPickerTarget) return;
    const target = cloudPickerTarget;
    const passToUse = overridePass || cloudPasswordInput || encryptionPassword || undefined;

    // Point 9: Check password BEFORE downloading if file is encrypted
    if (b.name.endsWith('.enc') && !passToUse) {
      setCloudPasswordPromptFile(b);
      setCloudPasswordError(null);
      setPasswordAttemptCount(0);
      return;
    }

    try {
      setIsVerifyingPassword(true);
      const isAlreadyCached = cachedEncryptedDownload?.fileId === b.id;
      if (!isAlreadyCached) {
        setIsDownloadingCloud(true);
        setCloudDownloadProgress(0);
      }
      const file = await downloadCloudFile(
        b.id,
        b.name,
        (pct) => setCloudDownloadProgress(pct),
        passToUse
      );

      // Point 7: Close download modal immediately upon download completion!
      setIsDownloadingCloud(false);
      setCloudDownloadProgress(null);
      setIsVerifyingPassword(false);
      setPasswordAttemptCount(0);
      setCloudPickerTarget(null);
      setCloudPasswordPromptFile(null);
      setCloudPasswordInput('');
      setCloudPasswordError(null);

      // Now start decompression and SQLite load — user sees progress on target backup card!
      if (target === 'primary') {
        await loadPrimary(file);
      } else {
        await loadSecondary(file);
      }
    } catch (err: any) {
      setIsDownloadingCloud(false);
      setCloudDownloadProgress(null);
      setIsVerifyingPassword(false);
      setPasswordAttemptCount((prev) => prev + 1);
      if (err?.message === 'PASSWORD_REQUIRED') {
        setCloudPasswordPromptFile(b);
        setCloudPasswordError(null);
        return;
      }
      if (
        err?.message?.includes('decrypt') ||
        err?.message?.includes('tag') ||
        err?.message?.includes('password') ||
        err?.message?.includes('Decryption failed')
      ) {
        setCloudPasswordPromptFile(b);
        setCloudPasswordError(t('cloud.invalidPassword', 'Incorrect password. Please try again.'));
        return;
      }
      setErrorMessage(t('cloud.loadCloudError', 'Failed to load cloud backup: ') + (err?.message || String(err)));
    }
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cloudPasswordPromptFile || isVerifyingPassword || isDownloadingCloud) return;
    setCloudPasswordError(null);
    setIsVerifyingPassword(true);
    if (cloudPasswordInput) {
      setEncryptionConfig(true, cloudPasswordInput, 0);
    }
    handleSelectCloudBackup(cloudPasswordPromptFile, cloudPasswordInput);
  };

  const handleExecuteMerge = async (
    exclusionsToUse?: Set<string>,
    overridesToUse?: Record<string, { title?: string; content?: string }>
  ) => {
    if (!primaryFile || !secondaryFile) return;

    try {
      setIsMerging(true);
      setErrorMessage(null);
      setCloudSaveSuccess(false);
      setMergeProgress({
        stage: t('merge.progressInit', 'Initializing merge engine...'),
        current: 0,
        total: 100,
      });
      setAppIsLoading(true, t('merge.merging', 'Merging...'));

      const effectiveExclusions = (exclusionsToUse instanceof Set) ? exclusionsToUse : excludedNoteGuids;
      const effectiveOverrides = overridesToUse !== undefined ? overridesToUse : noteOverrides;

      const tagRules: TagManagerMap = {};

      const conflictResolutions: Record<string, 'both' | 'a' | 'b'> = {};
      conflicts.forEach((c) => {
        conflictResolutions[c.id] = c.choice;
      });

      const result = await mergeJwLibraries(
        primaryFile.dbBytes,
        primaryFile.manifest,
        [
          {
            name: secondaryFile.file.name,
            dbBytes: secondaryFile.dbBytes,
            manifest: secondaryFile.manifest,
            extraFiles: secondaryFile.extraFiles,
          },
        ],
        {
          primaryName: outputName.replace(/\.jwlibrary$/i, ''),
          doctorCheck: true,
          conflictResolutions,
          secondaryNoteTag: tagImportedNotes ? (customImportTagName.trim() || 'From Merge') : undefined,
          excludedNoteGuids: Array.from(effectiveExclusions),
          noteOverrides: effectiveOverrides,
        },
        tagRules,
        (p) => {
          setMergeProgress(p);
          const pct = Math.round((p.current / p.total) * 100);
          setAppIsLoading(true, `${p.stage} (${pct}%)`);
        },
        primaryFile.extraFiles
      );

      setMergeResult(result);
      setLastMergedExcludedGuids(new Set(effectiveExclusions));
      setLastMergedNoteOverrides({ ...effectiveOverrides });

      setCandidateNotes((prev) => (prev.length === 0 ? result.details.addedNotes : prev));
      setCandidateDuplicates((prev) => (prev.length === 0 ? result.details.unifiedDuplicates : prev));
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : (typeof err === 'string' ? err : (err?.message || JSON.stringify(err)));
      setErrorMessage(`Merge failed: ${msg}`);
    } finally {
      setIsMerging(false);
      setAppIsLoading(false);
    }
  };

  const handleDownload = () => {
    if (!mergeResult) return;
    const downloadBlob = mergeResult.mergedBlob.type === 'application/octet-stream'
      ? mergeResult.mergedBlob
      : new Blob([mergeResult.mergedBlob], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(downloadBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName.endsWith('.jwlibrary') ? outputName : `${outputName}.jwlibrary`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleOpenInExplorer = async () => {
    if (!mergeResult) return;
    try {
      setIsOpenInAppLoading(true);
      await updateActiveDatabase(
        mergeResult.mergedDbBytes,
        mergeResult.manifest,
        mergeResult.extraFiles,
        mergeResult.mergedBlob
      );
      navigate('/explorer');
    } catch (err: any) {
      setErrorMessage(t('merge.loadPrimaryError', 'Failed to load into app: ') + (err?.message || String(err)));
    } finally {
      setIsOpenInAppLoading(false);
    }
  };

  const handleCloudSaveMerged = async () => {
    if (!mergeResult) return;
    try {
      setIsUploadingMerged(true);
      setUploadProgressMerged(0);
      await updateActiveDatabase(
        mergeResult.mergedDbBytes,
        mergeResult.manifest,
        mergeResult.extraFiles,
        mergeResult.mergedBlob
      );
      const sha256 = await computeSha256(mergeResult.mergedDbBytes);
      await backupFileDirectly(
        mergeResult.mergedBlob,
        outputName,
        sha256,
        (percent) => setUploadProgressMerged(percent),
        useAppStore.getState().summary || undefined
      );
      setCloudSaveSuccess(true);
    } catch (err: any) {
      setErrorMessage(t('cloud.saveError', 'Cloud save error: ') + (err?.message || String(err)));
    } finally {
      setIsUploadingMerged(false);
      setUploadProgressMerged(null);
    }
  };

  const bothFilesLoaded = !!(primaryFile && secondaryFile);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* ── HEADER ────────────────────────────────────────────────────── */}
      <div className="text-center space-y-2 max-w-xl mx-auto">
        <h1 className="text-2xl sm:text-4xl font-extrabold text-slate-900 dark:text-white tracking-tight">
          {t('merge.heroTitle', 'Multi-Device Backup Merge')}
        </h1>
        <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400">
          {t('merge.heroSubtitle', 'Combine phone and tablet backups into a single unified archive with automated deduplication.')}
        </p>
        <div className="pt-1 flex items-center justify-center space-x-4">
          <button
            type="button"
            onClick={handleLoadDemoFiles}
            className="inline-flex items-center space-x-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('merge.loadDemoPair', 'Try with demo files')}</span>
          </button>
          {(primaryFile || secondaryFile || mergeResult) && (
            <button
              type="button"
              onClick={handleResetMerge}
              className="inline-flex items-center space-x-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-red-500 font-medium transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('merge.cleanMerge', 'Reset')}</span>
            </button>
          )}
        </div>
      </div>

      {/* Error alert */}
      {errorMessage && (
        <div className="p-3.5 bg-red-500/10 dark:bg-red-950/40 border border-red-500/30 rounded-xl text-xs text-red-600 dark:text-red-300 text-center">
          {errorMessage}
        </div>
      )}

      {/* ── DROPZONES (SOURCE A & SOURCE B) ────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* SOURCE A */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingPrimary(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingPrimary(false);
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingPrimary(false);
            const files = Array.from(e.dataTransfer.files).filter(
              (f) => f.name.endsWith('.jwlibrary') || f.name.endsWith('.zip')
            );
            if (files.length === 1) {
              await loadPrimary(files[0]);
            } else if (files.length >= 2) {
              await loadPrimary(files[0]);
              await loadSecondary(files[1]);
            }
          }}
          className={`rounded-2xl border transition-all p-5 space-y-3 shadow-sm ${
            isDraggingPrimary
              ? 'border-blue-500 ring-2 ring-blue-500/30 bg-blue-50/20 dark:bg-blue-950/20'
              : 'border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#101625]'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs font-bold text-slate-700 dark:text-slate-300">
              <Smartphone className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>{t('merge.sourceA', 'Source A (Phone)')}</span>
            </div>
            {isLoadingPrimary ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/25 flex items-center space-x-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>{primaryProgress?.percent ? `${primaryProgress.percent}%` : t('common.loading', 'Loading...')}</span>
              </span>
            ) : isUploadingPrimary ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/25 flex items-center space-x-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Cloud {uploadProgressPrimary ?? 0}%</span>
              </span>
            ) : primaryFile ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                <Check className="w-3 h-3" />
                <span>{t('common.loaded', 'Loaded')}</span>
              </span>
            ) : (
              <span className="text-[10px] text-slate-400">{t('common.required', 'Required')}</span>
            )}
          </div>

          <input
            ref={primaryInputRef}
            type="file"
            accept=".jwlibrary"
            className="hidden"
            onChange={handlePrimaryUpload}
          />

          {isLoadingPrimary ? (
            <div className="border-2 border-dashed border-blue-500/40 rounded-xl p-6 text-center space-y-3 bg-blue-50/40 dark:bg-blue-950/20">
              <div className="relative w-10 h-10 mx-auto flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-blue-500/20 border-t-blue-600 dark:border-t-blue-400 animate-spin" />
                <Loader2 className="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-center space-x-2 text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                  <span>{primaryProgress?.stage || t('merge.loadingBackup', 'Reading backup archive...')}</span>
                  {primaryProgress?.percent !== undefined && (
                    <span className="text-blue-600 dark:text-blue-400 font-mono text-xs">
                      {primaryProgress.percent}%
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('common.processing', 'Processing client-side in WebAssembly...')}
                </p>
              </div>
              <div className="w-full bg-slate-200/80 dark:bg-slate-800 rounded-full h-2 overflow-hidden max-w-xs mx-auto">
                <div
                  className="bg-gradient-to-r from-blue-600 to-indigo-600 h-full transition-all duration-200 rounded-full"
                  style={{ width: `${primaryProgress?.percent ?? 15}%` }}
                />
              </div>
            </div>
          ) : !primaryFile ? (
            <div
              onClick={() => primaryInputRef.current?.click()}
              className="border-2 border-dashed border-slate-200 dark:border-white/[0.1] hover:border-blue-500/50 rounded-xl p-6 text-center cursor-pointer transition-all space-y-2 bg-slate-50/50 hover:bg-blue-50/20 dark:bg-white/[0.01] group"
            >
              <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center mx-auto text-blue-600 dark:text-blue-400">
                <Upload className="w-5 h-5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  {t('merge.dropHere', 'Drop .jwlibrary file here or click to browse')}
                </div>
                <p className="text-xs text-slate-500">Drop file here or click to browse</p>
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 dark:bg-white/[0.02] border border-slate-200/80 dark:border-white/[0.06] rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div
                    className="font-bold text-xs text-slate-900 dark:text-white truncate max-w-[200px] cursor-help"
                    title={primaryFile.file?.name ? `${primaryFile.summary.name} (${primaryFile.file.name})` : primaryFile.summary.name}
                  >
                    {primaryFile.summary.name}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {primaryFile.summary.deviceName} • {(primaryFile.file.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={handleLoadPrimaryIntoApp}
                    disabled={isLoadingAppPrimary}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-semibold flex items-center space-x-1"
                    title={t('merge.openInAppTooltip', 'Load this backup as the active database in the application')}
                  >
                    {isLoadingAppPrimary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Compass className="w-3 h-3" />}
                    <span>{isLoadingAppPrimary ? t('merge.loadingIntoApp', 'Loading...') : t('merge.openInApp', 'Open in App')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => primaryInputRef.current?.click()}
                    className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:underline font-semibold"
                  >
                    Change
                  </button>
                </div>
              </div>
              <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.04] text-[11px] text-slate-600 dark:text-slate-400 flex items-center space-x-1.5 flex-wrap">
                <span>{primaryFile.summary.notesCount} notes</span>
                <span>•</span>
                <span>{primaryFile.summary.userMarksCount} highlights</span>
                <span>•</span>
                <span>{primaryFile.summary.tagsCount} tags</span>
                <span>•</span>
                <span>{primaryFile.summary.playlistsCount} playlists</span>
              </div>

              {/* Cloud presence check & upload button */}
              {isConnected && (
                <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.04] flex items-center justify-between">
                  <div className="flex items-center space-x-1.5">
                    <Cloud className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-[11px] text-slate-500">Google Drive:</span>
                  </div>
                  {isShaInCloud(primaryFile.sha256) ? (
                    <span className="inline-flex items-center space-x-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{t('cloud.inCloudBadge', 'Saved in Cloud ✓')}</span>
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        onClick={handleUploadPrimaryToCloud}
                        disabled={isUploadingPrimary || isUploading}
                        className="inline-flex items-center space-x-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                      >
                        {isUploadingPrimary ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Upload className="w-3 h-3" />
                        )}
                        <span>
                          {isUploadingPrimary
                            ? `${t('merge.savingDrive', 'Uploading...')} ${uploadProgressPrimary ?? 0}%`
                            : t('cloud.uploadSource', 'Save to Drive')}
                        </span>
                      </button>
                      {isUploadingPrimary && (
                        <div className="w-24 bg-blue-100 dark:bg-blue-950 rounded-full h-1 overflow-hidden">
                          <div
                            className="bg-blue-600 dark:bg-blue-400 h-full transition-all duration-150 rounded-full"
                            style={{ width: `${Math.max(5, uploadProgressPrimary ?? 0)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {hasActiveInMemory ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleUseInMemory('primary')}
                className="py-1.5 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 flex items-center justify-center space-x-1.5 transition-all truncate"
                title={activeSummary?.name ? `${t('merge.useInMemory', 'Use Active File')}: ${activeSummary.name}` : t('merge.useInMemory', 'Use Active File')}
              >
                <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                <span className="truncate">{t('merge.activeFile', 'Active')}: {inMemoryShortName}</span>
              </button>
              <button
                type="button"
                onClick={() => isOnline && handlePickFromCloud('primary')}
                disabled={!isOnline}
                className={`py-1.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all truncate ${
                  !isOnline
                    ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                    : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                }`}
                title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
              >
                {!isOnline ? (
                  <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
                )}
                <span className="truncate">
                  {!isOnline
                    ? t('common.offline', 'Offline')
                    : isConnected
                    ? t('merge.chooseFromDrive', 'Choose from Google Drive')
                    : t('nav.connectDrive', 'Pick from Google Drive')}
                </span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => isOnline && handlePickFromCloud('primary')}
              disabled={!isOnline}
              className={`w-full py-1.5 px-3 rounded-xl text-xs font-medium flex items-center justify-center space-x-1.5 transition-all ${
                !isOnline
                  ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                  : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
              }`}
              title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
            >
              {!isOnline ? (
                <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              ) : (
                <Cloud className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              )}
              <span>
                {!isOnline
                  ? t('common.offline', 'Offline')
                  : isConnected
                  ? t('merge.chooseFromDrive', 'Choose from Google Drive')
                  : t('nav.connectDrive', 'Pick from Google Drive')}
              </span>
            </button>
          )}
        </div>

        {/* SOURCE B */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingSecondary(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingSecondary(false);
          }}
          onDrop={async (e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsDraggingSecondary(false);
            const files = Array.from(e.dataTransfer.files).filter(
              (f) => f.name.endsWith('.jwlibrary') || f.name.endsWith('.zip')
            );
            if (files.length === 1) {
              await loadSecondary(files[0]);
            } else if (files.length >= 2) {
              await loadPrimary(files[0]);
              await loadSecondary(files[1]);
            }
          }}
          className={`rounded-2xl border transition-all p-5 space-y-3 shadow-sm ${
            isDraggingSecondary
              ? 'border-sky-500 ring-2 ring-sky-500/30 bg-sky-50/20 dark:bg-sky-950/20'
              : 'border-slate-200/80 dark:border-white/[0.08] bg-white dark:bg-[#101625]'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs font-bold text-slate-700 dark:text-slate-300">
              <Tablet className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              <span>{t('merge.sourceB', 'Source B (Tablet)')}</span>
            </div>
            {isLoadingSecondary ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/25 flex items-center space-x-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>{secondaryProgress?.percent ? `${secondaryProgress.percent}%` : t('common.loading', 'Loading...')}</span>
              </span>
            ) : isUploadingSecondary ? (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/25 flex items-center space-x-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Cloud {uploadProgressSecondary ?? 0}%</span>
              </span>
            ) : secondaryFile ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                <Check className="w-3 h-3" />
                <span>{t('common.loaded', 'Loaded')}</span>
              </span>
            ) : (
              <span className="text-[10px] text-slate-400">{t('common.required', 'Required')}</span>
            )}
          </div>

          <input
            ref={secondaryInputRef}
            type="file"
            accept=".jwlibrary"
            className="hidden"
            onChange={handleSecondaryUpload}
          />

          {isLoadingSecondary ? (
            <div className="border-2 border-dashed border-sky-500/40 rounded-xl p-6 text-center space-y-3 bg-sky-50/40 dark:bg-sky-950/20">
              <div className="relative w-10 h-10 mx-auto flex items-center justify-center">
                <div className="absolute inset-0 rounded-full border-2 border-sky-500/20 border-t-sky-600 dark:border-t-sky-400 animate-spin" />
                <Loader2 className="w-5 h-5 text-sky-600 dark:text-sky-400 animate-spin" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-center space-x-2 text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                  <span>{secondaryProgress?.stage || t('merge.loadingBackup', 'Reading backup archive...')}</span>
                  {secondaryProgress?.percent !== undefined && (
                    <span className="text-sky-600 dark:text-sky-400 font-mono text-xs">
                      {secondaryProgress.percent}%
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {t('common.processing', 'Processing client-side in WebAssembly...')}
                </p>
              </div>
              <div className="w-full bg-slate-200/80 dark:bg-slate-800 rounded-full h-2 overflow-hidden max-w-xs mx-auto">
                <div
                  className="bg-gradient-to-r from-sky-600 to-blue-600 h-full transition-all duration-200 rounded-full"
                  style={{ width: `${secondaryProgress?.percent ?? 15}%` }}
                />
              </div>
            </div>
          ) : !secondaryFile ? (
            <div
              onClick={() => secondaryInputRef.current?.click()}
              className="border-2 border-dashed border-slate-200 dark:border-white/[0.1] hover:border-sky-500/50 rounded-xl p-6 text-center cursor-pointer transition-all space-y-2 bg-slate-50/50 hover:bg-sky-50/20 dark:bg-white/[0.01] group"
            >
              <div className="w-10 h-10 rounded-xl bg-sky-500/10 flex items-center justify-center mx-auto text-sky-600 dark:text-sky-400">
                <Upload className="w-5 h-5" />
              </div>
              <div className="space-y-0.5">
                <div className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                  {t('merge.dropHere', 'Drop .jwlibrary file here or click to browse')}
                </div>
                <p className="text-xs text-slate-500">Drop file here or click to browse</p>
              </div>
            </div>
          ) : (
            <div className="bg-slate-50 dark:bg-white/[0.02] border border-slate-200/80 dark:border-white/[0.06] rounded-xl p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <div className="min-w-0">
                  <div
                    className="font-bold text-xs text-slate-900 dark:text-white truncate max-w-[200px] cursor-help"
                    title={secondaryFile.file?.name ? `${secondaryFile.summary.name} (${secondaryFile.file.name})` : secondaryFile.summary.name}
                  >
                    {secondaryFile.summary.name}
                  </div>
                  <div className="text-[10px] text-slate-500">
                    {secondaryFile.summary.deviceName} • {(secondaryFile.file.size / 1024).toFixed(1)} KB
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={handleLoadSecondaryIntoApp}
                    disabled={isLoadingAppSecondary}
                    className="text-xs text-sky-600 dark:text-sky-400 hover:underline font-semibold flex items-center space-x-1"
                    title={t('merge.openInAppTooltip', 'Load this backup as the active database in the application')}
                  >
                    {isLoadingAppSecondary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Compass className="w-3 h-3" />}
                    <span>{isLoadingAppSecondary ? t('merge.loadingIntoApp', 'Loading...') : t('merge.openInApp', 'Open in App')}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => secondaryInputRef.current?.click()}
                    className="text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:underline font-semibold"
                  >
                    Change
                  </button>
                </div>
              </div>
              <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.04] text-[11px] text-slate-600 dark:text-slate-400 flex items-center space-x-1.5 flex-wrap">
                <span>{secondaryFile.summary.notesCount} notes</span>
                <span>•</span>
                <span>{secondaryFile.summary.userMarksCount} highlights</span>
                <span>•</span>
                <span>{secondaryFile.summary.tagsCount} tags</span>
                <span>•</span>
                <span>{secondaryFile.summary.playlistsCount} playlists</span>
              </div>

              {/* Cloud presence check & upload button */}
              {isConnected && (
                <div className="pt-1.5 border-t border-slate-200/60 dark:border-white/[0.04] flex items-center justify-between">
                  <div className="flex items-center space-x-1.5">
                    <Cloud className="w-3.5 h-3.5 text-slate-400" />
                    <span className="text-[11px] text-slate-500">Google Drive:</span>
                  </div>
                  {isShaInCloud(secondaryFile.sha256) ? (
                    <span className="inline-flex items-center space-x-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{t('cloud.inCloudBadge', 'Saved in Cloud ✓')}</span>
                    </span>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <button
                        type="button"
                        onClick={handleUploadSecondaryToCloud}
                        disabled={isUploadingSecondary || isUploading}
                        className="inline-flex items-center space-x-1 text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline disabled:opacity-50"
                      >
                        {isUploadingSecondary ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Upload className="w-3 h-3" />
                        )}
                        <span>
                          {isUploadingSecondary
                            ? `${t('merge.savingDrive', 'Uploading...')} ${uploadProgressSecondary ?? 0}%`
                            : t('cloud.uploadSource', 'Save to Drive')}
                        </span>
                      </button>
                      {isUploadingSecondary && (
                        <div className="w-24 bg-sky-100 dark:bg-sky-950 rounded-full h-1 overflow-hidden">
                          <div
                            className="bg-sky-600 dark:bg-sky-400 h-full transition-all duration-150 rounded-full"
                            style={{ width: `${Math.max(5, uploadProgressSecondary ?? 0)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {hasActiveInMemory ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleUseInMemory('secondary')}
                className="py-1.5 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 flex items-center justify-center space-x-1.5 transition-all truncate"
                title={activeSummary?.name ? `${t('merge.useInMemory', 'Use Active File')}: ${activeSummary.name}` : t('merge.useInMemory', 'Use Active File')}
              >
                <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                <span className="truncate">{t('merge.activeFile', 'Active')}: {inMemoryShortName}</span>
              </button>
              <button
                type="button"
                onClick={() => isOnline && handlePickFromCloud('secondary')}
                disabled={!isOnline}
                className={`py-1.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all truncate ${
                  !isOnline
                    ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                    : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                }`}
                title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
              >
                {!isOnline ? (
                  <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 flex-shrink-0" />
                )}
                <span className="truncate">
                  {!isOnline
                    ? t('common.offline', 'Offline')
                    : isConnected
                    ? t('merge.chooseFromDrive', 'Choose from Google Drive')
                    : t('nav.connectDrive', 'Pick from Google Drive')}
                </span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => isOnline && handlePickFromCloud('secondary')}
              disabled={!isOnline}
              className={`w-full py-1.5 px-3 rounded-xl text-xs font-medium flex items-center justify-center space-x-1.5 transition-all ${
                !isOnline
                  ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                  : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
              }`}
              title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
            >
              {!isOnline ? (
                <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
              ) : (
                <Cloud className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400 flex-shrink-0" />
              )}
              <span>
                {!isOnline
                  ? t('common.offline', 'Offline')
                  : isConnected
                  ? t('merge.chooseFromDrive', 'Choose from Google Drive')
                  : t('nav.connectDrive', 'Pick from Google Drive')}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* ── CONFLICT RESOLUTION (IF ANY) ───────────────────────────────── */}
      {bothFilesLoaded && !mergeResult && conflicts.length > 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#101625] p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2 text-xs font-bold text-slate-900 dark:text-white">
              <Sliders className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>Duplicate Verse Conflicts ({conflicts.length})</span>
            </div>
            <span className="text-[11px] text-slate-500">Choose which notes to keep:</span>
          </div>

          <div className="space-y-2.5">
            {conflicts.map((conf, idx) => (
              <div key={conf.id} className="p-3 bg-slate-50 dark:bg-white/[0.02] border border-slate-200/80 dark:border-white/[0.06] rounded-xl space-y-2 text-xs">
                <div className="font-semibold text-slate-800 dark:text-slate-200">
                  #{idx + 1}: {conf.verseAnchor}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <label className={`p-2.5 rounded-lg border cursor-pointer ${conf.choice === 'a' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-200 dark:border-white/[0.06]'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[11px]">Source A</span>
                      <input type="radio" name={`conf_${conf.id}`} checked={conf.choice === 'a'} onChange={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'a' } : c))} />
                    </div>
                    <p className="text-[11px] text-slate-500 line-clamp-2 mt-1">&ldquo;{conf.sourceAText}&rdquo;</p>
                  </label>
                  <label className={`p-2.5 rounded-lg border cursor-pointer ${conf.choice === 'b' ? 'border-blue-500 bg-blue-500/10' : 'border-slate-200 dark:border-white/[0.06]'}`}>
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-[11px]">Source B</span>
                      <input type="radio" name={`conf_${conf.id}`} checked={conf.choice === 'b'} onChange={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'b' } : c))} />
                    </div>
                    <p className="text-[11px] text-slate-500 line-clamp-2 mt-1">&ldquo;{conf.sourceBText}&rdquo;</p>
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'both' } : c))}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium ${conf.choice === 'both' ? 'bg-emerald-500/20 text-emerald-600 border border-emerald-500/30' : 'text-slate-500 hover:text-slate-800'}`}
                >
                  {t('merge.combineBoth', 'Keep Both Notes')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SMART TAGGING FOR IMPORTED NOTES ───────────────────────── */}
      {bothFilesLoaded && !mergeResult && (
        <div className="rounded-2xl border border-slate-200/90 dark:border-white/[0.08] bg-white dark:bg-[#101625] p-4 sm:p-5 space-y-3.5 shadow-sm transition-all">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start space-x-3">
              <div className="p-2 rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400 mt-0.5">
                <Tag className="w-4 h-4" />
              </div>
              <div>
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  {t('merge.tagImportedNotes', 'Tag notes imported from Backup 2')}
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                  {t('merge.tagImportedNotesDesc', 'Attach a tag to all notes imported from the second backup so you can easily review them under Personal Study > Tags in JW Library.')}
                </div>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                checked={tagImportedNotes}
                onChange={(e) => setTagImportedNotes(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-10 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          {tagImportedNotes && (
            <div className="pt-3 border-t border-slate-200/60 dark:border-white/[0.06] flex flex-wrap items-center gap-2.5 animate-in fade-in-50 duration-200">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {t('merge.tagImportedNotesLabel', 'Tag name')}:
              </span>
              <input
                type="text"
                value={customImportTagName}
                onChange={(e) => setCustomImportTagName(e.target.value)}
                placeholder={t('merge.fromMerge', 'From Merge')}
                className="text-xs bg-slate-50 dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.1] rounded-xl px-3.5 py-2 text-slate-900 dark:text-slate-100 font-medium focus:ring-1 focus:ring-blue-500 outline-none w-48 shadow-sm"
              />
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  onClick={() => setCustomImportTagName(t('merge.fromMerge', 'From Merge'))}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-300 transition-colors"
                >
                  {t('merge.fromMerge', 'From Merge')}
                </button>
                {secondaryFile?.summary?.deviceName && (
                  <button
                    type="button"
                    onClick={() => setCustomImportTagName(t('merge.fromDevice', { device: secondaryFile.summary.deviceName, defaultValue: `From ${secondaryFile.summary.deviceName}` }))}
                    className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-300 transition-colors truncate max-w-[180px]"
                  >
                    {t('merge.fromDevice', { device: secondaryFile.summary.deviceName, defaultValue: `From ${secondaryFile.summary.deviceName}` })}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setCustomImportTagName(t('merge.backup2', 'Backup 2'))}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-300 transition-colors"
                >
                  {t('merge.backup2', 'Backup 2')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── OUTPUT FILENAME & MERGE BUTTON ─────────────────────────────── */}
      {bothFilesLoaded && !mergeResult && (
        <div className="p-4 rounded-2xl bg-white dark:bg-[#101625] border border-slate-200 dark:border-white/[0.08] flex flex-col sm:flex-row items-center justify-between gap-3 shadow-sm">
          <div className="w-full sm:w-auto space-y-1">
            <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
              {t('merge.outputFilename', 'Combined Backup Name')}
            </label>
            <input
              type="text"
              value={outputName}
              onChange={(e) => setOutputName(e.target.value)}
              className="bg-slate-50 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.1] rounded-xl px-3 py-1.5 text-xs text-slate-900 dark:text-slate-100 font-mono w-full sm:w-72"
            />
          </div>

          <button
            type="button"
            onClick={() => handleExecuteMerge()}
            disabled={isMerging}
            className="w-full sm:w-auto px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs sm:text-sm tracking-wide transition-all shadow-lg shadow-blue-600/30 inline-flex items-center justify-center space-x-2"
          >
            <GitMerge className="w-4 h-4" />
            <span>{isMerging ? t('merge.merging', 'Merging...') : t('merge.buttonMerge', 'Generate & Download Combined Backup')}</span>
            <ArrowRight className="w-4 h-4 ml-1" />
          </button>
        </div>
      )}

      {/* ── PROGRESS BAR ───────────────────────────────────────────────── */}
      {isMerging && mergeProgress && (
        <div className="rounded-2xl border border-blue-500/40 bg-blue-50/70 dark:bg-blue-950/20 p-5 space-y-3 backdrop-blur-xl shadow-sm animate-in fade-in duration-200">
          <div className="flex items-center justify-between text-xs font-bold text-slate-900 dark:text-white">
            <div className="flex items-center space-x-2.5 min-w-0">
              <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0" />
              <div className="min-w-0">
                <span className="truncate block font-semibold text-slate-800 dark:text-slate-200">{mergeProgress.stage}</span>
                {mergeProgress.details && (
                  <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400 truncate block mt-0.5">
                    {mergeProgress.details}
                  </span>
                )}
              </div>
            </div>
            <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-300/40 dark:border-blue-700/50 flex-shrink-0 ml-3">
              {Math.min(100, Math.max(0, Math.round((mergeProgress.current / mergeProgress.total) * 100)))}%
            </span>
          </div>

          <div className="w-full bg-slate-200 dark:bg-slate-800/80 rounded-full h-2.5 overflow-hidden shadow-inner">
            <div
              className="bg-gradient-to-r from-blue-600 via-indigo-600 to-blue-500 h-full transition-all duration-300 ease-out rounded-full shadow-sm"
              style={{ width: `${Math.min(100, Math.max(0, Math.round((mergeProgress.current / mergeProgress.total) * 100)))}%` }}
            />
          </div>
        </div>
      )}

      {/* ── SUCCESS RESULT ─────────────────────────────────────────────── */}
      {mergeResult && (
        <div
          ref={resultRef}
          className="rounded-2xl border border-emerald-500/30 bg-white dark:bg-[#101625] p-6 space-y-5 shadow-lg animate-in zoom-in-95 duration-150"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-emerald-500/15">
            <div className="flex items-center space-x-2.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t('merge.successTitle', 'Merge Completed Successfully!')}</h2>
            </div>

            <button
              type="button"
              onClick={handleResetMerge}
              className="self-start sm:self-auto inline-flex items-center space-x-2 px-3.5 py-1.5 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-xs font-semibold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-white/[0.1] transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
              title={t('merge.cleanMergeDesc', 'Start a fresh new merge')}
            >
              <RotateCcw className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
              <span>{t('merge.newMerge', 'New Merge')}</span>
            </button>
          </div>

          <div className="p-3 bg-emerald-50/60 dark:bg-emerald-950/20 rounded-xl border border-emerald-500/20 text-xs text-emerald-800 dark:text-emerald-300 flex flex-wrap gap-x-4 gap-y-1 font-medium">
            <span>{t('merge.statNewNotes', { count: mergeResult.stats.notesAdded, defaultValue: `+${mergeResult.stats.notesAdded} new notes` })}</span>
            <span>•</span>
            <span>{t('merge.statDuplicatesUnified', { count: mergeResult.stats.notesMerged, defaultValue: `${mergeResult.stats.notesMerged} duplicates unified` })}</span>
            <span>•</span>
            <span>{t('merge.statHighlightsCombined', { count: mergeResult.stats.marksAdded, defaultValue: `+${mergeResult.stats.marksAdded} highlights combined` })}</span>
            <span>•</span>
            <span>{t('merge.statTagsConsolidated', { count: mergeResult.stats.tagsAdded, defaultValue: `+${mergeResult.stats.tagsAdded} tags consolidated` })}</span>
            {mergeResult.stats.bookmarksAdded > 0 && (
              <>
                <span>•</span>
                <span>{t('merge.statBookmarksAdded', { count: mergeResult.stats.bookmarksAdded, defaultValue: `+${mergeResult.stats.bookmarksAdded} bookmarks added` })}</span>
              </>
            )}
            {(mergeResult.stats.playlistsMerged ?? 0) > 0 && (
              <>
                <span>•</span>
                <span>{t('merge.statPlaylistsMerged', { count: mergeResult.stats.playlistsMerged, defaultValue: `+${mergeResult.stats.playlistsMerged} playlists merged` })}</span>
              </>
            )}
          </div>

          {/* ── Detailed Breakdown (Collapsible / Foldable View) ── */}
          <MergeDetailedBreakdown
            mergeResult={mergeResult}
            candidateNotes={candidateNotes}
            candidateDuplicates={candidateDuplicates}
            excludedNoteGuids={excludedNoteGuids}
            noteOverrides={noteOverrides}
            toggleNoteExclusion={toggleNoteExclusion}
            setNoteOverride={handleSetNoteOverride}
            setExcludedNoteGuids={setExcludedNoteGuids}
            showDetails={showDetails}
            setShowDetails={setShowDetails}
            hasUnsavedChanges={hasUnsavedExclusionChanges}
            onRemerge={() => handleExecuteMerge()}
            isMerging={isMerging}
          />

          <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-2">
            <button
              type="button"
              onClick={handleDownload}
              className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs transition-all shadow-md shadow-blue-600/25"
            >
              <Download className="w-4 h-4" />
              <span>{t('merge.downloadCombined', 'Download Combined Backup')}</span>
            </button>

            <div className="flex flex-col items-center gap-1.5 w-full sm:w-auto">
              <button
                type="button"
                onClick={handleCloudSaveMerged}
                disabled={isUploading || isUploadingMerged || cloudSaveSuccess}
                className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-4 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] text-xs font-semibold transition-all disabled:opacity-75"
              >
                {isUploading || isUploadingMerged ? (
                  <Loader2 className="w-4 h-4 text-blue-600 dark:text-blue-400 animate-spin" />
                ) : (
                  <Cloud className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                )}
                <span>
                  {cloudSaveSuccess
                    ? t('merge.savedDrive', 'Saved in Cloud ✓')
                    : isUploading || isUploadingMerged
                    ? `${t('merge.savingDrive', 'Uploading...')} ${uploadProgressMerged ?? uploadProgress ?? 0}%`
                    : t('merge.saveDrive', 'Save to Drive')}
                </span>
              </button>
              {(isUploading || isUploadingMerged) && (
                <div className="w-full bg-blue-100 dark:bg-blue-950 rounded-full h-1 overflow-hidden">
                  <div
                    className="bg-blue-600 dark:bg-blue-400 h-full transition-all duration-150 rounded-full"
                    style={{ width: `${Math.max(5, uploadProgressMerged ?? uploadProgress ?? 0)}%` }}
                  />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={handleOpenInExplorer}
              disabled={isOpenInAppLoading}
              className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-4 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] text-xs font-semibold transition-all disabled:opacity-60"
            >
              {isOpenInAppLoading ? (
                <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />
              ) : (
                <Compass className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              )}
              <span>{isOpenInAppLoading ? t('merge.loadingIntoApp', 'Loading into App...') : t('merge.exploreInApp', 'Explore in App')}</span>
            </button>

            <button
              type="button"
              onClick={handleResetMerge}
              className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-4 py-3 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-white/[0.1] text-xs font-semibold transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
              title={t('merge.cleanMergeDesc', 'Start a fresh new merge')}
            >
              <RotateCcw className="w-4 h-4 text-blue-600 dark:text-blue-400" />
              <span>{t('merge.newMerge', 'New Merge')}</span>
            </button>
          </div>
        </div>
      )}


      {/* ── GOOGLE DRIVE CLOUD FILE PICKER MODAL ───────────────────────── */}
      {cloudPickerTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111726] border border-slate-200 dark:border-white/[0.1] rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/[0.06]">
              <div className="flex items-center space-x-2 text-sm font-bold text-slate-900 dark:text-white">
                <Cloud className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                <span>
                  {t('merge.selectBackupFor')} {cloudPickerTarget === 'primary' ? 'Source A' : 'Source B'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCloudPickerTarget(null);
                  setCloudPasswordPromptFile(null);
                  setCloudPasswordInput('');
                  setCloudPasswordError(null);
                }}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isDownloadingCloud ? (
              <div className="py-8 text-center space-y-3">
                <div className="relative mx-auto w-12 h-12 flex items-center justify-center">
                  <RefreshCw className="w-10 h-10 text-blue-600 dark:text-blue-400 animate-spin opacity-40" />
                  <span className="absolute font-bold text-xs text-blue-600 dark:text-blue-400 font-mono">
                    {cloudDownloadProgress ?? 0}%
                  </span>
                </div>
                <div className="space-y-1">
                  <p className="text-xs text-slate-700 dark:text-slate-200 font-semibold">
                    {t('cloud.downloadingFromDrive', 'Downloading backup from Google Drive...')}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {t('cloud.closingWindowNote', 'Window will close automatically once download completes.')}
                  </p>
                </div>
                <div className="w-48 mx-auto bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-blue-600 h-full transition-all duration-150 rounded-full"
                    style={{ width: `${Math.max(5, cloudDownloadProgress ?? 5)}%` }}
                  />
                </div>
              </div>
            ) : cloudPasswordPromptFile ? (
              <form onSubmit={handlePasswordSubmit} className="space-y-4 py-2">
                <div className="p-3.5 bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 rounded-2xl space-y-1.5">
                  <div className="flex items-center space-x-2 text-xs font-bold text-amber-800 dark:text-amber-300">
                    <Lock className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                    <span className="truncate">{cloudPasswordPromptFile.name}</span>
                  </div>
                  <p className="text-[11px] text-amber-700/90 dark:text-amber-300/80 leading-relaxed">
                    {t('cloud.encryptedBackupPrompt', 'This backup is encrypted with AES-256-GCM. Please enter the password to decrypt it.')}
                  </p>
                </div>

                {cloudPasswordError && (
                  <div
                    key={passwordAttemptCount}
                    className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-600 dark:text-red-400 font-medium flex items-center space-x-2 animate-shake"
                  >
                    <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-500" />
                    <div className="flex-1">
                      <span>{cloudPasswordError}</span>
                      {passwordAttemptCount > 1 && (
                        <span className="block text-[10px] text-red-500/80 mt-0.5 font-normal">
                          {t('cloud.attemptFailed', { count: passwordAttemptCount, defaultValue: `Attempt ${passwordAttemptCount} failed` })}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                <div className="space-y-1.5">
                  <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {t('cloud.encryptionPassword', 'Decryption Password')}
                  </label>
                  <input
                    type="password"
                    autoFocus
                    required
                    disabled={isVerifyingPassword}
                    value={cloudPasswordInput}
                    onChange={(e) => {
                      setCloudPasswordInput(e.target.value);
                      if (cloudPasswordError) setCloudPasswordError(null);
                    }}
                    placeholder="Enter password..."
                    className="w-full bg-slate-50 dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                  />
                </div>

                <div className="flex items-center justify-end space-x-2 pt-2">
                  <button
                    type="button"
                    disabled={isVerifyingPassword}
                    onClick={() => {
                      setCloudPasswordPromptFile(null);
                      setCloudPasswordInput('');
                      setCloudPasswordError(null);
                      setPasswordAttemptCount(0);
                    }}
                    className="px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-50"
                  >
                    {t('common.cancel', 'Cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isVerifyingPassword || !cloudPasswordInput.trim()}
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold text-xs transition-all shadow-md shadow-blue-600/20 flex items-center space-x-1.5"
                  >
                    {isVerifyingPassword && (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    )}
                    <span>
                      {isVerifyingPassword
                        ? t('cloud.verifyingPassword', 'Verifying password...')
                        : cachedEncryptedDownload?.fileId === cloudPasswordPromptFile.id
                        ? t('cloud.unlockCached', 'Unlock Backup')
                        : t('cloud.unlockAndDownload', 'Unlock & Download')}
                    </span>
                  </button>
                </div>
              </form>
            ) : backups.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500 dark:text-slate-400 space-y-2">
                <p>{t('merge.noCloudBackups', 'No backups found in your Google Drive “Panda JL Studio” folder.')}</p>
              </div>
            ) : (
              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                {backups.map((b) => {
                  const isEncrypted = b.name.endsWith('.enc');
                  const displayName = isEncrypted ? b.name.slice(0, -4) : b.name;
                  return (
                    <div
                      key={b.id}
                      onClick={() => handleSelectCloudBackup(b)}
                      className="p-3 rounded-xl bg-slate-50 hover:bg-blue-50 dark:bg-white/[0.02] dark:hover:bg-blue-500/10 border border-slate-200 dark:border-white/[0.06] hover:border-blue-500/40 cursor-pointer flex items-center justify-between text-xs transition-colors"
                    >
                      <div className="truncate max-w-[80%] space-y-1">
                        <div className="font-semibold text-slate-800 dark:text-slate-200 truncate flex items-center space-x-1.5">
                          <span className="truncate">{displayName}</span>
                          {isEncrypted && (
                            <span
                              className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30 flex-shrink-0"
                              title={t('cloud.encryptedTooltip', 'AES-256 Encrypted')}
                            >
                              <Lock className="w-2.5 h-2.5" />
                              <span>{t('cloud.encryptedBadge', 'Encrypted')}</span>
                            </span>
                          )}
                          {b.isValidated === false && (
                            <span
                              className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 flex-shrink-0"
                              title={t('cloud.unverifiedTooltip', 'This backup has not been integrity-validated or may be incomplete.')}
                            >
                              <AlertCircle className="w-2.5 h-2.5 text-amber-500" />
                              <span>{t('cloud.unverifiedBadge', 'Unverified')}</span>
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-500 dark:text-slate-400 flex items-center space-x-2 flex-wrap">
                          <span>
                            {b.createdTime ? new Date(b.createdTime).toLocaleDateString() : 'Recent'}
                            {b.size ? ` • ${(parseInt(b.size, 10) / 1024).toFixed(1)} KB` : ''}
                          </span>
                          {(b.notesCount !== undefined || b.tagsCount !== undefined || b.playlistsCount !== undefined) && (
                            <span className="text-slate-600 dark:text-slate-300 font-medium">
                              • {[
                                  b.notesCount !== undefined ? `${b.notesCount} ${t('nav.notes', 'notes')}` : null,
                                  b.tagsCount !== undefined ? `${b.tagsCount} ${t('nav.tags', 'tags')}` : null,
                                  b.playlistsCount !== undefined ? `${b.playlistsCount} ${t('nav.playlists', 'playlists')}` : null,
                                ].filter(Boolean).join(' • ')}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="text-blue-600 dark:text-blue-400 font-semibold text-xs flex-shrink-0 ml-2">Select →</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
