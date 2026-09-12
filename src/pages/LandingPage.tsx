import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
  HelpCircle,
  Tag,
  Database,
  Lock,
  WifiOff,
  AlertCircle,
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

interface ILoadedFileState {
  file: File;
  dbBytes: Uint8Array;
  manifest: IManifest;
  summary: ILibrarySummary;
  extraFiles: Map<string, Uint8Array>;
  sha256: string;
}

export const LandingPage: React.FC = () => {
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

  // Detailed View, Exclusion & Note Override State
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [candidateNotes, setCandidateNotes] = useState<IMergeDetailedNote[]>([]);
  const [candidateDuplicates, setCandidateDuplicates] = useState<IMergeDetailedNote[]>([]);
  const [excludedNoteGuids, setExcludedNoteGuids] = useState<Set<string>>(new Set());
  const [lastMergedExcludedGuids, setLastMergedExcludedGuids] = useState<Set<string>>(new Set());
  const [noteOverrides, setNoteOverrides] = useState<Record<string, { title?: string; content?: string }>>({});
  const [lastMergedNoteOverrides, setLastMergedNoteOverrides] = useState<Record<string, { title?: string; content?: string }>>({});

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

  const hasUnsavedChanges =
    excludedNoteGuids.size !== lastMergedExcludedGuids.size ||
    Array.from(excludedNoteGuids).some((g) => !lastMergedExcludedGuids.has(g)) ||
    JSON.stringify(noteOverrides) !== JSON.stringify(lastMergedNoteOverrides);

  const resetMergeDetailsState = () => {
    setMergeResult(null);
    setShowDetails(false);
    setCandidateNotes([]);
    setCandidateDuplicates([]);
    setExcludedNoteGuids(new Set());
    setLastMergedExcludedGuids(new Set());
    setNoteOverrides({});
    setLastMergedNoteOverrides({});
  };

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
      resetMergeDetailsState();

      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);
      setPrimaryProgress({ stage: t('merge.progressChecksum', 'Verifying integrity...'), percent: 30 });
      const sha256 = await computeSha256(fileBytes);

      const { manifest, dbBytes, fileSizeBytes, extraFiles } = await extractJwLibrary(
        file,
        file.name,
        (p) => {
          setPrimaryProgress({ stage: p.stage, percent: p.percent });
          setAppIsLoading(true, `Backup 1: ${p.stage} (${p.percent}%)`);
        }
      );

      setPrimaryProgress({ stage: t('merge.progressSqlite', 'Analyzing SQLite database...'), percent: 90 });
      const db = await openDatabase(dbBytes);
      const summary = getLibrarySummary(db, manifest, fileSizeBytes);
      db.close();

      setPrimaryFile({ file, dbBytes, manifest, summary, extraFiles, sha256 });
      setPrimaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
    } catch (err: any) {
      setErrorMessage(t('merge.loadPrimaryError', 'Failed to load Source A: ') + (err?.message || String(err)));
    } finally {
      setIsLoadingPrimary(false);
      primaryLoadingRef.current = false;
      setAppIsLoading(false);
    }
  };

  const loadSecondary = async (file: File) => {
    try {
      secondaryLoadingRef.current = true;
      setIsLoadingSecondary(true);
      setSecondaryProgress({ stage: t('merge.progressUnpacking', 'Unpacking backup archive...'), percent: 10 });
      setAppIsLoading(true, t('merge.loadingSourceB', 'Loading Source B into app...'));
      setErrorMessage(null);
      resetMergeDetailsState();

      const arrayBuffer = await file.arrayBuffer();
      const fileBytes = new Uint8Array(arrayBuffer);
      setSecondaryProgress({ stage: t('merge.progressChecksum', 'Verifying integrity...'), percent: 30 });
      const sha256 = await computeSha256(fileBytes);

      const { manifest, dbBytes, fileSizeBytes, extraFiles } = await extractJwLibrary(
        file,
        file.name,
        (p) => {
          setSecondaryProgress({ stage: p.stage, percent: p.percent });
          setAppIsLoading(true, `Backup 2: ${p.stage} (${p.percent}%)`);
        }
      );

      setSecondaryProgress({ stage: t('merge.progressSqlite', 'Analyzing SQLite database...'), percent: 90 });
      const db = await openDatabase(dbBytes);
      const summary = getLibrarySummary(db, manifest, fileSizeBytes);
      db.close();

      setSecondaryFile({ file, dbBytes, manifest, summary, extraFiles, sha256 });
      setSecondaryProgress({ stage: t('merge.progressReady', 'Ready!'), percent: 100 });
    } catch (err: any) {
      setErrorMessage(t('merge.loadSecondaryError', 'Failed to load Source B: ') + (err?.message || String(err)));
    } finally {
      setIsLoadingSecondary(false);
      secondaryLoadingRef.current = false;
      setAppIsLoading(false);
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
      } catch (e) {
        console.warn('Conflict detection non-critical error:', e);
      }
    })();
  }, [primaryFile, secondaryFile]);

  const handlePrimaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await loadPrimary(file);
    } catch (err) {
      setErrorMessage('Failed to read primary file: ' + (err as Error).message);
    }
  };

  const handleSecondaryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await loadSecondary(file);
    } catch (err) {
      setErrorMessage('Failed to read secondary file: ' + (err as Error).message);
    }
  };

  const handleLoadDemoFiles = async () => {
    try {
      setErrorMessage(null);
      const res1 = await fetch('/example.jwlibrary');
      const blob1 = await res1.blob();
      const f1 = new File([blob1], 'Phone_Study.jwlibrary', { type: 'application/zip' });
      await loadPrimary(f1);

      const res2 = await fetch('/example2.jwlibrary');
      const blob2 = await res2.blob();
      const f2 = new File([blob2], 'Tablet_Study.jwlibrary', { type: 'application/zip' });
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

      // Now start decompression and SQLite load — user sees progress on the target backup card!
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

  const handleOpenPrimaryInApp = async () => {
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

  const handleOpenSecondaryInApp = async () => {
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

  const handleResetMerge = () => {
    setPrimaryFile(null);
    setSecondaryFile(null);
    setPrimaryProgress(null);
    setSecondaryProgress(null);
    setUploadProgressPrimary(null);
    setUploadProgressSecondary(null);
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
    if (primaryInputRef.current) primaryInputRef.current.value = '';
    if (secondaryInputRef.current) secondaryInputRef.current.value = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
        undefined,
        useAppStore.getState().summary || undefined
      );
      setCloudSaveSuccess(true);
    } catch (err: any) {
      setErrorMessage(t('cloud.saveError', 'Cloud save error: ') + (err?.message || String(err)));
    }
  };

  const bothFilesLoaded = !!(primaryFile && secondaryFile);

  return (
    <div className="relative overflow-hidden pb-12 space-y-8">
      {/* Background ambient lighting */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[400px] bg-gradient-to-b from-emerald-600/15 via-teal-600/5 to-transparent blur-3xl pointer-events-none -z-10" />

      {/* ── HEADER HERO ────────────────────────────────────────────── */}
      <section className="pt-6 sm:pt-10 px-4 sm:px-6 lg:px-8 max-w-3xl mx-auto text-center space-y-3">
        <div className="inline-flex items-center space-x-2 px-3.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 text-xs font-semibold backdrop-blur-md">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
          <span>{t('landing.privacyBadge', '100% Client-Side SQLite WASM • Zero Upload')}</span>
        </div>

        <h1 className="text-3xl sm:text-5xl font-black text-slate-900 dark:text-white tracking-tight leading-tight">
          {t('merge.heroTitle', 'JW Library Backup Merge & Reconciler')}
        </h1>

        <p className="text-xs sm:text-base text-slate-600 dark:text-slate-300 max-w-xl mx-auto leading-relaxed">
          {t('merge.heroSubtitle', 'Harmonize and synthesize study notes, marks, and tags across independent backups without data loss.')}
        </p>
      </section>

      {/* Error alert */}
      {errorMessage && (
        <div className="max-w-3xl mx-auto px-4">
          <div className="p-3.5 bg-red-500/10 dark:bg-red-950/40 border border-red-500/30 rounded-2xl text-xs text-red-600 dark:text-red-300 text-center">
            {errorMessage}
          </div>
        </div>
      )}

      {/* ── CARDS: BACKUP 1 & BACKUP 2 DROPZONES ──────── */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-11 gap-4 items-center">

          {/* LEFT CARD: BACKUP 1 */}
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
            className={`md:col-span-5 rounded-3xl border transition-all p-6 space-y-4 backdrop-blur-xl shadow-lg shadow-slate-900/5 dark:shadow-black/40 ${isDraggingPrimary
                ? 'border-emerald-500 ring-2 ring-emerald-500/30 bg-emerald-50/20 dark:bg-emerald-950/20'
                : 'border-slate-200/90 dark:border-white/[0.08] bg-white/90 dark:bg-[#101625]/85 hover:border-emerald-500/40'
              }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                <Database className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{t('merge.backup1', 'Backup 1')}</span>
              </div>
              {isLoadingPrimary ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{primaryProgress?.percent ?? 10}%</span>
                </span>
              ) : isUploadingPrimary ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Cloud {uploadProgressPrimary ?? 0}%</span>
                </span>
              ) : primaryFile ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                  <Check className="w-3 h-3" />
                  <span>{t('common.loaded', 'Loaded')}</span>
                </span>
              ) : (
                <span className="text-[10px] font-medium text-slate-400">{t('common.required', 'Required')}</span>
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
              <div className="border-2 border-dashed border-emerald-400 dark:border-emerald-600/60 rounded-2xl p-6 text-center space-y-3 bg-emerald-50/40 dark:bg-emerald-950/20">
                <div className="flex items-center justify-center space-x-2 text-emerald-600 dark:text-emerald-400">
                  <div className="relative">
                    <div className="w-8 h-8 rounded-full border-2 border-emerald-600/30 border-t-emerald-600 animate-spin" />
                    <Loader2 className="w-4 h-4 text-emerald-600 animate-spin absolute inset-0 m-auto" />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    {primaryProgress?.stage || t('merge.loadingBackup', 'Reading backup archive...')}
                  </div>
                  <div className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                    {primaryProgress?.percent ?? 10}%
                  </div>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-emerald-600 h-full transition-all duration-200 rounded-full"
                    style={{ width: `${primaryProgress?.percent ?? 10}%` }}
                  />
                </div>
              </div>
            ) : !primaryFile ? (
              <div
                onClick={() => primaryInputRef.current?.click()}
                className="group border-2 border-dashed border-slate-200 dark:border-white/[0.08] hover:border-emerald-500/50 rounded-2xl p-7 text-center cursor-pointer transition-all space-y-3 bg-slate-50/60 hover:bg-emerald-50/20 dark:bg-white/[0.01] dark:hover:bg-white/[0.03]"
              >
                <div className="w-16 h-16 rounded-2xl border-2 border-slate-300 dark:border-white/[0.1] group-hover:border-emerald-500 dark:group-hover:border-emerald-400 flex flex-col items-center justify-center p-2 mx-auto transition-colors shadow-sm bg-slate-100/50 dark:bg-white/[0.02]">
                  <Database className="w-7 h-7 text-slate-400 group-hover:text-emerald-500 dark:text-slate-500 dark:group-hover:text-emerald-400 transition-colors" />
                </div>
                <div className="space-y-1">
                  <div className="text-base sm:text-lg font-bold text-slate-900 dark:text-white group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors leading-snug">
                    {t('merge.dropHere', 'Drop .jwlibrary file here or click to browse')}
                  </div>
                  <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">{t('merge.backup1Desc', 'First study backup (.jwlibrary)')}</div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-50/80 dark:bg-[#0b0f19] border border-slate-200/80 dark:border-white/[0.06] rounded-2xl p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div
                      className="font-bold text-xs text-slate-900 dark:text-white truncate max-w-[200px] cursor-help"
                      title={primaryFile.file?.name ? `${primaryFile.summary.name} (${primaryFile.file.name})` : primaryFile.summary.name}
                    >
                      {primaryFile.summary.name}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {primaryFile.summary.deviceName} • {(primaryFile.file.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => primaryInputRef.current?.click()}
                    className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline font-semibold"
                  >
                    Change
                  </button>
                </div>
                <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.04] text-[11px] text-slate-600 dark:text-slate-400 flex items-center space-x-1.5 flex-wrap">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{primaryFile.summary.notesCount}</span> {t('nav.notes', 'notes')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{primaryFile.summary.userMarksCount}</span> {t('explorer.filterHighlights', 'highlights')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{primaryFile.summary.tagsCount}</span> {t('nav.tags', 'tags')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{primaryFile.summary.playlistsCount}</span> {t('explorer.playlistsCategory', 'playlists')}
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-200/60 dark:border-white/[0.04] gap-2 flex-wrap">
                  {isConnected && (
                    isShaInCloud(primaryFile.sha256) ? (
                      <span className="inline-flex items-center space-x-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        <Check className="w-3 h-3" />
                        <span>{t('merge.savedDrive', 'Saved on Google Drive ✓')}</span>
                      </span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={handleUploadPrimaryToCloud}
                          disabled={isUploadingPrimary}
                          className="inline-flex items-center space-x-1.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline bg-emerald-50 dark:bg-emerald-950/30 px-2.5 py-0.5 rounded-full border border-emerald-300 dark:border-emerald-700/50"
                        >
                          {isUploadingPrimary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cloud className="w-3 h-3" />}
                          <span>
                            {isUploadingPrimary
                              ? `${t('merge.savingDrive', 'Uploading...')} ${uploadProgressPrimary ?? 0}%`
                              : t('merge.saveDrive', 'Upload to Drive')}
                          </span>
                        </button>
                        {isUploadingPrimary && (
                          <div className="w-full bg-emerald-100 dark:bg-emerald-950 rounded-full h-1 overflow-hidden">
                            <div
                              className="bg-emerald-600 dark:bg-emerald-400 h-full transition-all duration-150 rounded-full"
                              style={{ width: `${Math.max(5, uploadProgressPrimary ?? 0)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  )}

                  <button
                    type="button"
                    onClick={handleOpenPrimaryInApp}
                    disabled={isLoadingAppPrimary}
                    className="ml-auto inline-flex items-center space-x-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-2.5 py-1 rounded-lg transition-all"
                    title={t('merge.openInAppTooltip', 'Load this backup as active database in the application')}
                  >
                    {isLoadingAppPrimary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Compass className="w-3 h-3" />}
                    <span>{isLoadingAppPrimary ? t('merge.loadingIntoApp', 'Loading...') : t('merge.openInApp', 'Open in App')}</span>
                  </button>
                </div>
              </div>
            )}

            {hasActiveInMemory ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleUseInMemory('primary')}
                  className="py-2 px-3 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-semibold text-emerald-700 dark:text-emerald-300 border border-emerald-500/25 flex items-center justify-center space-x-1.5 transition-all truncate"
                  title={activeSummary?.name ? `${t('merge.useInMemory', 'Use Active File')}: ${activeSummary.name}` : t('merge.useInMemory', 'Use Active File')}
                >
                  <Database className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
                  <span className="truncate">{t('merge.activeFile', 'Active')}: {inMemoryShortName}</span>
                </button>
                <button
                  type="button"
                  onClick={() => isOnline && handlePickFromCloud('primary')}
                  disabled={!isOnline}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all truncate ${!isOnline
                      ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                      : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                    }`}
                  title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
                >
                  {!isOnline ? (
                    <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  ) : (
                    <Cloud className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
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
                className={`w-full py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${!isOnline
                    ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                    : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                  }`}
                title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
              >
                {!isOnline ? (
                  <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
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

          {/* CONNECTOR CIRCLE */}
          <div className="md:col-span-1 flex flex-col items-center justify-center py-2 md:py-0">
            <div
              className={`w-13 h-13 rounded-2xl flex items-center justify-center transition-all duration-300 border ${bothFilesLoaded
                  ? 'bg-emerald-600 text-white border-emerald-400 shadow-lg shadow-emerald-500/40 scale-110'
                  : 'bg-slate-100/90 dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-400'
                }`}
            >
              <GitMerge className={`w-5 h-5 ${bothFilesLoaded ? 'animate-pulse' : ''}`} />
            </div>
          </div>

          {/* RIGHT CARD: BACKUP 2 */}
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
            className={`md:col-span-5 rounded-3xl border transition-all p-6 space-y-4 backdrop-blur-xl shadow-lg shadow-slate-900/5 dark:shadow-black/40 ${isDraggingSecondary
                ? 'border-teal-500 ring-2 ring-teal-500/30 bg-teal-50/20 dark:bg-teal-950/20'
                : 'border-slate-200/90 dark:border-white/[0.08] bg-white/90 dark:bg-[#101625]/85 hover:border-teal-500/40'
              }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                <GitMerge className="w-4 h-4 text-teal-600 dark:text-teal-400" />
                <span>{t('merge.backup2', 'Backup 2')}</span>
              </div>
              {isLoadingSecondary ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/25 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>{secondaryProgress?.percent ?? 10}%</span>
                </span>
              ) : isUploadingSecondary ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-500/10 text-teal-600 dark:text-teal-400 border border-teal-500/25 flex items-center space-x-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  <span>Cloud {uploadProgressSecondary ?? 0}%</span>
                </span>
              ) : secondaryFile ? (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 flex items-center space-x-1">
                  <Check className="w-3 h-3" />
                  <span>{t('common.loaded', 'Loaded')}</span>
                </span>
              ) : (
                <span className="text-[10px] font-medium text-slate-400">{t('common.required', 'Required')}</span>
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
              <div className="border-2 border-dashed border-teal-400 dark:border-teal-600/60 rounded-2xl p-6 text-center space-y-3 bg-teal-50/40 dark:bg-teal-950/20">
                <div className="flex items-center justify-center space-x-2 text-teal-600 dark:text-teal-400">
                  <div className="relative">
                    <div className="w-8 h-8 rounded-full border-2 border-teal-600/30 border-t-teal-600 animate-spin" />
                    <Loader2 className="w-4 h-4 text-teal-600 animate-spin absolute inset-0 m-auto" />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-slate-800 dark:text-slate-200">
                    {secondaryProgress?.stage || t('merge.loadingBackup', 'Reading backup archive...')}
                  </div>
                  <div className="text-[11px] font-mono text-teal-600 dark:text-teal-400 font-semibold">
                    {secondaryProgress?.percent ?? 10}%
                  </div>
                </div>
                <div className="w-full bg-slate-200 dark:bg-slate-800 rounded-full h-1.5 overflow-hidden">
                  <div
                    className="bg-teal-600 h-full transition-all duration-200 rounded-full"
                    style={{ width: `${secondaryProgress?.percent ?? 10}%` }}
                  />
                </div>
              </div>
            ) : !secondaryFile ? (
              <div
                onClick={() => secondaryInputRef.current?.click()}
                className="group border-2 border-dashed border-slate-200 dark:border-white/[0.08] hover:border-teal-500/50 rounded-2xl p-7 text-center cursor-pointer transition-all space-y-3 bg-slate-50/60 hover:bg-teal-50/20 dark:bg-white/[0.01] dark:hover:bg-white/[0.03]"
              >
                <div className="w-16 h-16 rounded-2xl border-2 border-slate-300 dark:border-white/[0.1] group-hover:border-teal-500 dark:group-hover:border-teal-400 flex flex-col items-center justify-center p-2 mx-auto transition-colors shadow-sm bg-slate-100/50 dark:bg-white/[0.02]">
                  <GitMerge className="w-7 h-7 text-slate-400 group-hover:text-teal-500 dark:text-slate-500 dark:group-hover:text-teal-400 transition-colors" />
                </div>
                <div className="space-y-1">
                  <div className="text-base sm:text-lg font-bold text-slate-900 dark:text-white group-hover:text-teal-600 dark:group-hover:text-teal-400 transition-colors leading-snug">
                    {t('merge.dropHere', 'Drop .jwlibrary file here or click to browse')}
                  </div>
                  <div className="text-xs sm:text-sm text-slate-500 dark:text-slate-400 font-medium">{t('merge.backup2Desc', 'Second study backup (.jwlibrary)')}</div>
                </div>
              </div>
            ) : (
              <div className="bg-slate-50/80 dark:bg-[#0b0f19] border border-slate-200/80 dark:border-white/[0.06] rounded-2xl p-4 space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="min-w-0">
                    <div
                      className="font-bold text-xs text-slate-900 dark:text-white truncate max-w-[200px] cursor-help"
                      title={secondaryFile.file?.name ? `${secondaryFile.summary.name} (${secondaryFile.file.name})` : secondaryFile.summary.name}
                    >
                      {secondaryFile.summary.name}
                    </div>
                    <div className="text-[10px] text-slate-500 dark:text-slate-400">
                      {secondaryFile.summary.deviceName} • {(secondaryFile.file.size / 1024).toFixed(1)} KB
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => secondaryInputRef.current?.click()}
                    className="text-xs text-teal-600 dark:text-teal-400 hover:underline font-semibold"
                  >
                    Change
                  </button>
                </div>
                <div className="pt-2 border-t border-slate-200/60 dark:border-white/[0.04] text-[11px] text-slate-600 dark:text-slate-400 flex items-center space-x-1.5 flex-wrap">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{secondaryFile.summary.notesCount}</span> {t('nav.notes', 'notes')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{secondaryFile.summary.userMarksCount}</span> {t('explorer.filterHighlights', 'highlights')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{secondaryFile.summary.tagsCount}</span> {t('nav.tags', 'tags')}
                  <span>•</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-200">{secondaryFile.summary.playlistsCount}</span> {t('explorer.playlistsCategory', 'playlists')}
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-200/60 dark:border-white/[0.04] gap-2 flex-wrap">
                  {isConnected && (
                    isShaInCloud(secondaryFile.sha256) ? (
                      <span className="inline-flex items-center space-x-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                        <Check className="w-3 h-3" />
                        <span>{t('merge.savedDrive', 'Saved on Google Drive ✓')}</span>
                      </span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <button
                          type="button"
                          onClick={handleUploadSecondaryToCloud}
                          disabled={isUploadingSecondary}
                          className="inline-flex items-center space-x-1.5 text-[10px] font-semibold text-teal-600 dark:text-teal-400 hover:underline bg-teal-50 dark:bg-teal-950/30 px-2.5 py-0.5 rounded-full border border-teal-300 dark:border-teal-700/50"
                        >
                          {isUploadingSecondary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Cloud className="w-3 h-3" />}
                          <span>
                            {isUploadingSecondary
                              ? `${t('merge.savingDrive', 'Uploading...')} ${uploadProgressSecondary ?? 0}%`
                              : t('merge.saveDrive', 'Upload to Drive')}
                          </span>
                        </button>
                        {isUploadingSecondary && (
                          <div className="w-full bg-teal-100 dark:bg-teal-950 rounded-full h-1 overflow-hidden">
                            <div
                              className="bg-teal-600 dark:bg-teal-400 h-full transition-all duration-150 rounded-full"
                              style={{ width: `${Math.max(5, uploadProgressSecondary ?? 0)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    )
                  )}

                  <button
                    type="button"
                    onClick={handleOpenSecondaryInApp}
                    disabled={isLoadingAppSecondary}
                    className="ml-auto inline-flex items-center space-x-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300 hover:text-teal-600 dark:hover:text-teal-400 bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] px-2.5 py-1 rounded-lg transition-all"
                    title={t('merge.openInAppTooltip', 'Load this backup as active database in the application')}
                  >
                    {isLoadingAppSecondary ? <Loader2 className="w-3 h-3 animate-spin" /> : <Compass className="w-3 h-3" />}
                    <span>{isLoadingAppSecondary ? t('merge.loadingIntoApp', 'Loading...') : t('merge.openInApp', 'Open in App')}</span>
                  </button>
                </div>
              </div>
            )}

            {hasActiveInMemory ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => handleUseInMemory('secondary')}
                  className="py-2 px-3 rounded-xl bg-teal-500/10 hover:bg-teal-500/20 text-xs font-semibold text-teal-700 dark:text-teal-300 border border-teal-500/25 flex items-center justify-center space-x-1.5 transition-all truncate"
                  title={activeSummary?.name ? `${t('merge.useInMemory', 'Use Active File')}: ${activeSummary.name}` : t('merge.useInMemory', 'Use Active File')}
                >
                  <Database className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 flex-shrink-0" />
                  <span className="truncate">{t('merge.activeFile', 'Active')}: {inMemoryShortName}</span>
                </button>
                <button
                  type="button"
                  onClick={() => isOnline && handlePickFromCloud('secondary')}
                  disabled={!isOnline}
                  className={`py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all truncate ${!isOnline
                      ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                      : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                    }`}
                  title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
                >
                  {!isOnline ? (
                    <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                  ) : (
                    <Cloud className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 flex-shrink-0" />
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
                className={`w-full py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all ${!isOnline
                    ? 'bg-slate-100 dark:bg-white/[0.02] text-slate-400 dark:text-slate-500 opacity-60 cursor-not-allowed border border-dashed border-slate-200 dark:border-white/[0.06]'
                    : 'bg-slate-100 hover:bg-slate-200/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300'
                  }`}
                title={!isOnline ? t('common.offlineDriveDisabled', 'Google Drive unavailable while offline') : ''}
              >
                {!isOnline ? (
                  <WifiOff className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                ) : (
                  <Cloud className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 flex-shrink-0" />
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
      </section>

      {/* ── CONFLICT RESOLUTION IF ANY ─────────────────────────────── */}
      {bothFilesLoaded && !mergeResult && conflicts.length > 0 && (
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#101625] p-5 sm:p-6 space-y-4 shadow-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 text-xs font-bold text-slate-900 dark:text-white">
                <Sliders className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>Verse Collisions Detected ({conflicts.length})</span>
              </div>
              <span className="text-[11px] text-slate-500">Choose how to resolve:</span>
            </div>

            <div className="space-y-3">
              {conflicts.map((conf, idx) => (
                <div key={conf.id} className="p-3.5 bg-slate-50 dark:bg-[#0b0f19] border border-slate-200/80 dark:border-white/[0.06] rounded-2xl space-y-2.5 text-xs">
                  <div className="font-semibold text-slate-800 dark:text-slate-200">
                    Collision #{idx + 1}: {conf.verseAnchor}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <label className={`p-3 rounded-xl border cursor-pointer transition-all ${conf.choice === 'a' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-200 dark:border-white/[0.06]'}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs">{t('merge.backup1', 'Backup 1')} ({primaryFile.summary.deviceName || 'Source 1'})</span>
                        <input type="radio" name={`conf_${conf.id}`} checked={conf.choice === 'a'} onChange={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'a' } : c))} className="accent-emerald-600" />
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 line-clamp-2 mt-1">&ldquo;{conf.sourceAText}&rdquo;</p>
                    </label>
                    <label className={`p-3 rounded-xl border cursor-pointer transition-all ${conf.choice === 'b' ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-200 dark:border-white/[0.06]'}`}>
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-xs">{t('merge.backup2', 'Backup 2')} ({secondaryFile.summary.deviceName || 'Source 2'})</span>
                        <input type="radio" name={`conf_${conf.id}`} checked={conf.choice === 'b'} onChange={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'b' } : c))} className="accent-emerald-600" />
                      </div>
                      <p className="text-[11px] text-slate-600 dark:text-slate-400 line-clamp-2 mt-1">&ldquo;{conf.sourceBText}&rdquo;</p>
                    </label>
                  </div>
                  <button
                    type="button"
                    onClick={() => setConflicts(prev => prev.map(c => c.id === conf.id ? { ...c, choice: 'both' } : c))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${conf.choice === 'both' ? 'bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`}
                  >
                    {t('merge.combineBoth', 'Consolidate Both Notes')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── SMART TAGGING FOR IMPORTED NOTES ───────────────────────── */}
      {bothFilesLoaded && !mergeResult && (
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-slate-200/90 dark:border-white/[0.08] bg-white/90 dark:bg-[#101625]/90 p-5 space-y-3.5 shadow-md backdrop-blur-xl transition-all">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-start space-x-3">
                <div className="p-2 rounded-xl bg-teal-500/10 text-teal-600 dark:text-teal-400 mt-0.5">
                  <Tag className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-900 dark:text-white">
                    {t('merge.tagImportedNotes', 'Tag notes imported from Backup 2')}
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
                    {t('merge.tagImportedNotesDesc', 'Attach a tag to all notes imported from Backup 2 so you can easily review them under Personal Study > Tags in JW Library.')}
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
                <div className="w-10 h-5 bg-slate-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-600"></div>
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
                  className="text-xs bg-slate-50 dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.1] rounded-xl px-3.5 py-2 text-slate-900 dark:text-slate-100 font-medium focus:ring-1 focus:ring-emerald-500 outline-none w-48 shadow-sm"
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
        </section>
      )}

      {/* ── ACTION BUTTON: MERGE ARCHIVES ─────────────────────────── */}
      {bothFilesLoaded && !mergeResult && (
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="p-4 sm:p-5 rounded-3xl bg-white/90 dark:bg-[#101625]/90 border border-slate-200/90 dark:border-white/[0.08] flex flex-col sm:flex-row items-center justify-between gap-4 shadow-xl backdrop-blur-xl">
            <div className="w-full sm:w-auto space-y-1">
              <label className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {t('merge.outputFilename', 'Combined Backup Archive Name')}
              </label>
              <input
                type="text"
                value={outputName}
                onChange={(e) => setOutputName(e.target.value)}
                className="bg-slate-50 dark:bg-[#0b0f19] border border-slate-200 dark:border-white/[0.1] rounded-xl px-3.5 py-2 text-xs text-slate-900 dark:text-slate-100 font-mono w-full sm:w-80 shadow-sm focus:ring-1 focus:ring-emerald-500 outline-none"
              />
            </div>

            <button
              type="button"
              onClick={() => handleExecuteMerge()}
              disabled={isMerging}
              className="w-full sm:w-auto px-8 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-sm tracking-wide transition-all shadow-xl shadow-emerald-600/30 hover:scale-[1.02] active:scale-[0.98] inline-flex items-center justify-center space-x-2"
            >
              <GitMerge className="w-4 h-4" />
              <span>{isMerging ? t('merge.merging', 'Merging...') : t('merge.mergeBackups', 'Merge Backups')}</span>
              <ArrowRight className="w-4 h-4 ml-1" />
            </button>
          </div>
        </section>
      )}

      {/* ── MERGE PROGRESS ─────────────────────────────────────────── */}
      {isMerging && mergeProgress && (
        <section className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl border border-emerald-500/40 bg-emerald-50/70 dark:bg-emerald-950/20 p-5 space-y-3 backdrop-blur-xl shadow-md animate-in fade-in duration-200">
            <div className="flex items-center justify-between text-xs font-bold text-slate-900 dark:text-white">
              <div className="flex items-center space-x-2.5 min-w-0">
                <Loader2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 animate-spin flex-shrink-0" />
                <div className="min-w-0">
                  <span className="truncate block font-semibold text-slate-800 dark:text-slate-200">{mergeProgress.stage}</span>
                  {mergeProgress.details && (
                    <span className="text-[11px] font-normal text-slate-500 dark:text-slate-400 truncate block mt-0.5">
                      {mergeProgress.details}
                    </span>
                  )}
                </div>
              </div>
              <span className="text-xs font-mono font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 border border-emerald-300/40 dark:border-emerald-700/50 flex-shrink-0 ml-3">
                {Math.min(100, Math.max(0, Math.round((mergeProgress.current / mergeProgress.total) * 100)))}%
              </span>
            </div>
            <div className="w-full bg-slate-200 dark:bg-slate-800/80 rounded-full h-2.5 overflow-hidden shadow-inner">
              <div
                className="bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-500 h-full transition-all duration-300 ease-out rounded-full shadow-sm"
                style={{ width: `${Math.min(100, Math.max(0, Math.round((mergeProgress.current / mergeProgress.total) * 100)))}%` }}
              />
            </div>
          </div>
        </section>
      )}

      {/* ── MERGE SUCCESS RESULT ───────────────────────────────────── */}
      {mergeResult && (
        <section ref={resultRef} className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 animate-in zoom-in-95 duration-200">
          <div className="rounded-3xl border border-emerald-500/35 bg-white/95 dark:bg-[#101625]/95 p-6 sm:p-8 space-y-5 shadow-2xl backdrop-blur-xl">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-emerald-500/15">
              <div className="flex items-center space-x-3 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-6 h-6 flex-shrink-0" />
                <h2 className="text-xl font-black text-slate-900 dark:text-white">
                  {t('merge.successTitle', 'Merge Completed Successfully!')}
                </h2>
              </div>

              <button
                type="button"
                onClick={handleResetMerge}
                className="self-start sm:self-auto inline-flex items-center space-x-2 px-4 py-2 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-xs font-bold text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-white/[0.1] transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
                title={t('merge.cleanMergeDesc', 'Start a fresh new merge')}
              >
                <RotateCcw className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                <span>{t('merge.newMerge', 'New Merge')}</span>
              </button>
            </div>

            <div className="p-3.5 bg-emerald-50/70 dark:bg-emerald-950/20 rounded-2xl border border-emerald-500/20 text-xs text-emerald-800 dark:text-emerald-300 flex flex-wrap gap-x-5 gap-y-1.5 font-semibold">
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
              hasUnsavedChanges={hasUnsavedChanges}
              onRemerge={() => handleExecuteMerge()}
              isMerging={isMerging}
            />

            <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
              <button
                type="button"
                onClick={handleDownload}
                className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold text-xs transition-all shadow-lg shadow-emerald-600/30 hover:scale-[1.02] active:scale-[0.98]"
              >
                <Download className="w-4 h-4" />
                <span>{t('merge.downloadCombined', 'Download Combined Backup')}</span>
              </button>

              <button
                type="button"
                onClick={handleCloudSaveMerged}
                disabled={isUploading || cloudSaveSuccess}
                className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-3.5 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] text-xs font-semibold transition-all"
              >
                <Cloud className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{cloudSaveSuccess ? t('merge.savedDrive') : isUploading ? t('merge.savingDrive') : t('merge.saveDrive')}</span>
              </button>

              <button
                type="button"
                onClick={handleOpenInExplorer}
                disabled={isOpenInAppLoading}
                className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-3.5 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] text-xs font-semibold transition-all disabled:opacity-60"
              >
                {isOpenInAppLoading ? (
                  <Loader2 className="w-4 h-4 text-emerald-600 animate-spin" />
                ) : (
                  <Compass className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                )}
                <span>{isOpenInAppLoading ? t('merge.loadingIntoApp', 'Loading into App...') : t('merge.exploreInApp', 'Explore in App')}</span>
              </button>

              <button
                type="button"
                onClick={handleResetMerge}
                className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-3.5 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.06] dark:hover:bg-white/[0.12] text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-white/[0.1] text-xs font-semibold transition-all shadow-sm hover:scale-[1.02] active:scale-[0.98]"
                title={t('merge.cleanMergeDesc', 'Start a fresh new merge')}
              >
                <RotateCcw className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{t('merge.newMerge', 'New Merge')}</span>
              </button>
            </div>
          </div>
        </section>
      )}

      {/* ── DEMO PAIR & HELP LINKS (BELOW DROPZONES, JUST ABOVE FOOTER) ── */}
      <section className="text-center pt-2 pb-6">
        <div className="inline-flex items-center space-x-3 text-xs text-slate-500 dark:text-slate-400 bg-slate-100/70 dark:bg-white/[0.03] border border-slate-200/80 dark:border-white/[0.06] px-4 py-2 rounded-2xl backdrop-blur-md shadow-sm">
          <button
            type="button"
            onClick={handleLoadDemoFiles}
            className="inline-flex items-center space-x-1.5 text-emerald-600 dark:text-emerald-400 hover:underline font-semibold"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{t('merge.loadDemoPair', 'Load Demo Pair (Sample Files)')}</span>
          </button>
          <span className="text-slate-300 dark:text-slate-700">•</span>
          <Link
            to="/help"
            className="inline-flex items-center space-x-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white font-medium"
          >
            <HelpCircle className="w-3.5 h-3.5 text-emerald-500" />
            <span>{t('merge.howToExport', 'How to export?')}</span>
          </Link>
          {(primaryFile || secondaryFile || mergeResult) && (
            <>
              <span className="text-slate-300 dark:text-slate-700">•</span>
              <button
                type="button"
                onClick={handleResetMerge}
                className="inline-flex items-center space-x-1.5 text-slate-600 dark:text-slate-400 hover:text-red-500 font-medium transition-colors"
                title={t('merge.cleanMergeDesc', 'Start a fresh new merge')}
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>{t('merge.cleanMerge', 'Reset')}</span>
              </button>
            </>
          )}
        </div>
      </section>

      {/* ── GOOGLE DRIVE CLOUD PICKER MODAL ────────────────────────── */}
      {cloudPickerTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-[#111726] border border-slate-200 dark:border-white/[0.1] rounded-3xl max-w-md w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-white/[0.06]">
              <div className="flex items-center space-x-2 text-sm font-bold text-slate-900 dark:text-white">
                <Cloud className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>
                  Select Backup for {cloudPickerTarget === 'primary' ? t('merge.backup1', 'Backup 1') : t('merge.backup2', 'Backup 2')}
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
                  <RefreshCw className="w-10 h-10 text-emerald-600 dark:text-emerald-400 animate-spin opacity-40" />
                  <span className="absolute font-bold text-xs text-emerald-600 dark:text-emerald-400 font-mono">
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
                    className="bg-emerald-600 h-full transition-all duration-150 rounded-full"
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
                    className="w-full bg-slate-50 dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
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
                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-semibold text-xs transition-all shadow-md shadow-emerald-600/20 flex items-center space-x-1.5"
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
                <p>{t('cloud.noBackupsFound', 'No archives found in your Google Drive “Panda JL Studio” folder.')}</p>
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
                      className="p-3 rounded-xl bg-slate-50 hover:bg-emerald-50 dark:bg-white/[0.02] dark:hover:bg-emerald-500/10 border border-slate-200 dark:border-white/[0.06] hover:border-emerald-500/40 cursor-pointer flex items-center justify-between text-xs transition-colors"
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
                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-xs flex-shrink-0 ml-2">Select →</span>
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
