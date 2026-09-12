import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Cloud,
  X,
  Upload,
  Download,
  Trash2,
  RefreshCw,
  HardDrive,
  Lock,
  Unlock,
  Key,
  Search,
  ArrowUpDown,
  GitMerge,
  CheckSquare,
  Square,
  Settings,
  AlertCircle,
  Bell,
  CheckCircle2,
  Edit3,
  FileText,
  Tag,
  ListMusic,
  Bookmark,
  FolderOpen,
} from 'lucide-react';
import { useCloudStore } from '../../store/useCloudStore';
import { useAppStore } from '../../store/useAppStore';
import { getGoogleClientId, getLocalDeviceId, IDriveFile } from '../../lib/cloud/googleDrive';
import { validateBackupName, getEditableBaseName } from '../../lib/cloud/renameSchema';
import { useTranslation } from 'react-i18next';

export const CloudSyncModal: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    isConnected,
    isSessionExpired,
    backups,
    isLoading,
    isUploading,
    statusMessage,
    error,
    downloadProgress,
    uploadProgress,
    connect,
    disconnect,
    refreshBackups,
    backupCurrentLibrary,
    restoreCloudBackup,
    renameCloudBackup,
    deleteCloudBackup,
    batchDeleteBackups,
    downloadCloudFile,
    setShowCloudModal,
    clearError,
    encryptionEnabled,
    encryptionPassword,
    setEncryptionConfig,
    deviceSyncNotificationsEnabled,
    setDeviceSyncNotificationsEnabled,
    acknowledgeCloudBackups,
    isShaInCloud,
    uploadCustomFile,
  } = useCloudStore();

  const { activeLibraryBytes, activeSha256, summary } = useAppStore();
  const hasClientId = !!getGoogleClientId();

  const directFileInputRef = React.useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [customBackupName, setCustomBackupName] = useState('');

  // Encryption & Notification Settings UI
  const [showSettings, setShowSettings] = useState(false);
  const [encToggle, setEncToggle] = useState(encryptionEnabled);
  const [encPass, setEncPass] = useState(encryptionPassword || '');
  const [encDuration, setEncDuration] = useState<number>(0);
  const [notifsToggle, setNotifsToggle] = useState(deviceSyncNotificationsEnabled);

  // Decryption Prompt UI
  const [promptFileId, setPromptFileId] = useState<string | null>(null);
  const [promptFileName, setPromptFileName] = useState<string | null>(null);
  const [promptAction, setPromptAction] = useState<'load' | 'merge' | 'download'>('load');
  const [decryptPass, setDecryptPass] = useState('');
  const [decryptError, setDecryptError] = useState('');
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptAttemptCount, setDecryptAttemptCount] = useState(0);
  const [downloadingFileId, setDownloadingFileId] = useState<string | null>(null);

  // Rename Prompt UI
  const [renamingBackup, setRenamingBackup] = useState<IDriveFile | null>(null);
  const [newBackupName, setNewBackupName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Clear cross-device notification count when modal is opened
  useEffect(() => {
    acknowledgeCloudBackups();
  }, [acknowledgeCloudBackups]);

  useEffect(() => {
    setEncToggle(encryptionEnabled);
    setEncPass(encryptionPassword || '');
  }, [encryptionEnabled, encryptionPassword]);

  useEffect(() => {
    setNotifsToggle(deviceSyncNotificationsEnabled);
  }, [deviceSyncNotificationsEnabled]);

  const isCurrentInCloud = activeSha256 ? isShaInCloud(activeSha256) : false;
  const myDeviceId = getLocalDeviceId();

  // Filter and sort backups
  const filteredBackups = useMemo(() => {
    let list = backups.filter((b) =>
      b.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    list = [...list].sort((a, b) => {
      const timeA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
      const timeB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
      return sortOrder === 'newest' ? timeB - timeA : timeA - timeB;
    });

    return list;
  }, [backups, searchQuery, sortOrder]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const selectAll = () => {
    if (selectedIds.length === filteredBackups.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredBackups.map((b) => b.id));
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.length === 0) return;
    if (
      window.confirm(
        t('cloud.confirmBatchDelete', {
          count: selectedIds.length,
          defaultValue: `Are you sure you want to permanently delete ${selectedIds.length} backup(s) from Google Drive?`,
        })
      )
    ) {
      await batchDeleteBackups(selectedIds);
      setSelectedIds([]);
    }
  };

  const handleMergeSelected = async () => {
    if (selectedIds.length !== 2) return;
    const file1Meta = backups.find((b) => b.id === selectedIds[0]);
    const file2Meta = backups.find((b) => b.id === selectedIds[1]);
    if (!file1Meta || !file2Meta) return;

    try {
      setShowCloudModal(false);
      const [f1, f2] = await Promise.all([
        downloadCloudFile(file1Meta.id, file1Meta.name),
        downloadCloudFile(file2Meta.id, file2Meta.name),
      ]);

      (window as any).__PANDA_PRELOAD_MERGE__ = {
        primary: f1,
        secondary: f2,
      };

      navigate('/merge');
    } catch (err: any) {
      if (err.message === 'PASSWORD_REQUIRED' || err.message.includes('Decryption failed')) {
        setShowCloudModal(true);
        setPromptAction('merge');
        setPromptFileId(selectedIds[0]);
        setDecryptError('Decryption required for merge.');
      } else {
        alert('Error downloading cloud files for merge: ' + err.message);
      }
    }
  };

  const handleUploadClick = async () => {
    try {
      if (encToggle && !encPass) {
        setShowSettings(true);
        alert(t('cloud.enterPasswordFirst', 'Please enter an encryption password in the settings first.'));
        return;
      }
      await backupCurrentLibrary(customBackupName.trim() || undefined);
      setCustomBackupName('');
    } catch (_) {}
  };

  const handleDirectFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (encToggle && !encPass) {
        setShowSettings(true);
        alert(t('cloud.enterPasswordFirst', 'Please enter an encryption password in the settings first.'));
        return;
      }
      await uploadCustomFile(file);
    } catch (_) {
      // Error is caught and surfaced in error state by store
    } finally {
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  const handleSaveSettings = () => {
    setEncryptionConfig(encToggle, encToggle ? encPass : null, encToggle ? encDuration : 0);
    setDeviceSyncNotificationsEnabled(notifsToggle);
    setShowSettings(false);
  };

  const handleRestoreClick = async (b: any) => {
    try {
      await restoreCloudBackup(b.id, b.name);
    } catch (err: any) {
      if (err.message === 'PASSWORD_REQUIRED' || err.message.includes('Decryption failed') || err.message.includes('decrypt')) {
        setPromptFileId(b.id);
        setPromptFileName(b.name);
        setPromptAction('load');
        setDecryptError(err.message === 'PASSWORD_REQUIRED' ? '' : t('cloud.invalidPassword', 'Incorrect password.'));
      }
    }
  };

  const saveFileToDisk = (file: File) => {
    const blob = file.type === 'application/octet-stream' ? file : new Blob([file], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);
  };

  const handleDownloadToDevice = async (b: IDriveFile) => {
    try {
      setDownloadingFileId(b.id);
      const file = await downloadCloudFile(b.id, b.name);
      saveFileToDisk(file);
    } catch (err: any) {
      if (err.message === 'PASSWORD_REQUIRED' || err.message.includes('Decryption failed') || err.message.includes('decrypt')) {
        setPromptFileId(b.id);
        setPromptFileName(b.name);
        setPromptAction('download');
        setDecryptError(err.message === 'PASSWORD_REQUIRED' ? '' : t('cloud.invalidPassword', 'Incorrect password.'));
      } else {
        alert(t('cloud.downloadError', 'Download error: ') + err.message);
      }
    } finally {
      setDownloadingFileId(null);
    }
  };

  const handleDecryptSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptFileId || !promptFileName) return;

    setEncryptionConfig(true, decryptPass, 0);
    setDecryptError('');
    setIsDecrypting(true);

    try {
      if (promptAction === 'load') {
        // Will decrypt in-memory cached buffer if already downloaded!
        await restoreCloudBackup(promptFileId, promptFileName, decryptPass);
        setPromptFileId(null);
        setDecryptPass('');
        setDecryptAttemptCount(0);
      } else if (promptAction === 'download') {
        const file = await downloadCloudFile(promptFileId, promptFileName, undefined, decryptPass);
        saveFileToDisk(file);
        setPromptFileId(null);
        setDecryptPass('');
        setDecryptAttemptCount(0);
      } else {
        await handleMergeSelected();
        setPromptFileId(null);
        setDecryptPass('');
        setDecryptAttemptCount(0);
      }
    } catch (err: any) {
      setDecryptAttemptCount((c) => c + 1);
      setDecryptError(t('cloud.invalidPassword', 'Incorrect password. Please try again.'));
      setEncryptionConfig(encryptionEnabled, encryptionPassword, 0);
    } finally {
      setIsDecrypting(false);
    }
  };

  const handleStartRename = (b: IDriveFile) => {
    setRenamingBackup(b);
    setNewBackupName(getEditableBaseName(b.name));
    setRenameError('');
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renamingBackup) return;

    const validation = validateBackupName({
      newName: newBackupName,
      originalName: renamingBackup.name,
    });

    if (!validation.isValid) {
      if (validation.errorCode === 'EMPTY') {
        setRenameError(t('cloud.renameErrorEmpty', 'File name cannot be empty'));
      } else if (validation.errorCode === 'INVALID_CHARS') {
        setRenameError(t('cloud.renameErrorInvalidChars', 'File name contains invalid characters'));
      } else if (validation.errorCode === 'SAME_NAME') {
        setRenameError(t('cloud.renameErrorSame', 'The new name is identical to the current name'));
      } else if (validation.errorCode === 'TOO_LONG') {
        setRenameError(t('cloud.renameErrorTooLong', 'File name is too long'));
      }
      return;
    }

    try {
      setIsRenaming(true);
      setRenameError('');
      await renameCloudBackup(renamingBackup.id, validation.sanitizedName!);
      setRenamingBackup(null);
      setNewBackupName('');
    } catch (err: any) {
      setRenameError(err.message || 'Failed to rename backup');
    } finally {
      setIsRenaming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-[#0e1422] border border-slate-200 dark:border-white/[0.12] text-slate-900 dark:text-white rounded-2xl max-w-2xl w-full p-4 sm:p-7 space-y-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        {/* Decryption Overlay */}
        {promptFileId && (
          <div className="absolute inset-0 z-50 bg-white/95 dark:bg-[#0e1422]/95 backdrop-blur-sm rounded-2xl flex items-center justify-center p-4 sm:p-6">
            <form
              onSubmit={handleDecryptSubmit}
              className="w-full max-w-sm space-y-4 bg-slate-50 dark:bg-white/[0.03] p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-white/[0.08] shadow-2xl"
            >
              <div className="text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-blue-500/20 mx-auto flex items-center justify-center text-blue-600 dark:text-blue-400 mb-4">
                  <Key className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  {t('cloud.encryptedFile', 'Encrypted File')}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {t('cloud.enterPasswordDesc', {
                    fileName: promptFileName,
                    defaultValue: `Enter password to decrypt ${promptFileName}`,
                  })}
                </p>
              </div>

              <div className="space-y-1">
                <input
                  type="password"
                  disabled={isDecrypting}
                  value={decryptPass}
                  onChange={(e) => {
                    setDecryptPass(e.target.value);
                    if (decryptError) setDecryptError('');
                  }}
                  placeholder={t('cloud.encryptionPassword', 'Encryption Password')}
                  className="w-full bg-white dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-4 py-2 text-sm text-slate-900 dark:text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
                  autoFocus
                />
                {decryptError && (
                  <div
                    key={decryptAttemptCount}
                    className="p-2 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-600 dark:text-red-400 font-medium flex items-center space-x-2 animate-shake mt-2"
                  >
                    <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-500" />
                    <div className="flex-1">
                      <span>{decryptError}</span>
                      {decryptAttemptCount > 1 && (
                        <span className="block text-[10px] text-red-500/80 mt-0.5 font-normal">
                          {t('cloud.attemptFailed', { count: decryptAttemptCount, defaultValue: `Attempt ${decryptAttemptCount} failed` })}
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex items-center space-x-2 pt-2">
                <button
                  type="button"
                  disabled={isDecrypting}
                  onClick={() => {
                    setPromptFileId(null);
                    setDecryptError('');
                    setDecryptPass('');
                    setDecryptAttemptCount(0);
                  }}
                  className="flex-1 py-2 rounded-xl border border-slate-300 dark:border-white/[0.1] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.05] disabled:opacity-50"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isDecrypting || !decryptPass.trim()}
                  className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white shadow-md flex items-center justify-center space-x-1.5"
                >
                  {isDecrypting && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>
                    {isDecrypting
                      ? t('cloud.verifyingPassword', 'Verifying password...')
                      : promptAction === 'download'
                      ? t('cloud.decryptAndDownload', 'Decrypt & Download')
                      : promptAction === 'merge'
                      ? t('cloud.decryptAndMerge', 'Decrypt & Merge')
                      : t('cloud.decryptAndLoad', 'Decrypt & Open in App')}
                  </span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Rename Overlay */}
        {renamingBackup && (
          <div className="absolute inset-0 z-50 bg-white/95 dark:bg-[#0e1422]/95 backdrop-blur-sm rounded-2xl flex items-center justify-center p-4 sm:p-6">
            <form
              onSubmit={handleRenameSubmit}
              className="w-full max-w-sm space-y-4 bg-slate-50 dark:bg-white/[0.03] p-5 sm:p-6 rounded-xl border border-slate-200 dark:border-white/[0.08] shadow-2xl"
            >
              <div className="text-center space-y-2">
                <div className="w-12 h-12 rounded-full bg-blue-500/20 mx-auto flex items-center justify-center text-blue-600 dark:text-blue-400 mb-4">
                  <Edit3 className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                  {t('cloud.renameBackupTitle', 'Rename Cloud Backup')}
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 break-all" title={renamingBackup.name}>
                  {renamingBackup.name}
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400 block">
                  {t('cloud.renameBackupDesc', 'Enter a new file name for this backup:')}
                </label>
                <div className="flex items-center rounded-xl border border-slate-300 dark:border-white/[0.1] bg-white dark:bg-[#0b0f17] focus-within:border-blue-500 overflow-hidden shadow-inner">
                  <input
                    type="text"
                    value={newBackupName}
                    onChange={(e) => {
                      setNewBackupName(e.target.value);
                      if (renameError) setRenameError('');
                    }}
                    placeholder="Backup_Name"
                    className="flex-1 bg-transparent px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:outline-none min-w-0"
                    autoFocus
                    disabled={isRenaming}
                  />
                  <span className="px-2.5 py-2 text-[11px] font-mono bg-slate-100 dark:bg-white/[0.05] text-slate-500 dark:text-slate-400 border-l border-slate-200 dark:border-white/[0.08] select-none flex-shrink-0">
                    {renamingBackup.name.endsWith('.enc') ? '.jwlibrary.enc' : '.jwlibrary'}
                  </span>
                </div>
                <p className="text-[10px] text-slate-400 dark:text-slate-500">
                  {t('cloud.extensionPreserved', {
                    ext: renamingBackup.name.endsWith('.enc') ? '.jwlibrary.enc' : '.jwlibrary',
                    defaultValue: `The ${renamingBackup.name.endsWith('.enc') ? '.jwlibrary.enc' : '.jwlibrary'} extension will be automatically preserved`,
                  })}
                </p>
                {renameError && <p className="text-[11px] text-red-500 mt-1">{renameError}</p>}
              </div>

              <div className="flex items-center space-x-2 pt-2">
                <button
                  type="button"
                  disabled={isRenaming}
                  onClick={() => {
                    setRenamingBackup(null);
                    setRenameError('');
                    setNewBackupName('');
                  }}
                  className="flex-1 py-2 rounded-xl border border-slate-300 dark:border-white/[0.1] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/[0.05] disabled:opacity-50"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  type="submit"
                  disabled={isRenaming || !newBackupName.trim()}
                  className="flex-1 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-xs font-semibold text-white shadow-md flex items-center justify-center space-x-1.5"
                >
                  {isRenaming && <RefreshCw className="w-3 h-3 animate-spin" />}
                  <span>{isRenaming ? t('common.loading', 'Saving...') : t('cloud.rename', 'Rename')}</span>
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 dark:border-white/[0.08]">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-slate-900 dark:text-white tracking-tight flex items-center space-x-2">
                <span>{t('cloud.title')}</span>
                {isConnected ? (
                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span>{t('cloud.connected')}</span>
                  </span>
                ) : isSessionExpired ? (
                  <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                    <span>{t('cloud.sessionExpiredBadge', 'Session expirée')}</span>
                  </span>
                ) : null}
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">{t('cloud.subtitle')}</p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            {isConnected && (
              <button
                type="button"
                onClick={() => setShowSettings(!showSettings)}
                className={`p-1.5 rounded-lg transition-colors ${
                  showSettings
                    ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06]'
                }`}
                title={t('cloud.encryptionSettingsTitle', 'Encryption Settings')}
              >
                <Settings className="w-5 h-5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowCloudModal(false)}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Status / Error alerts */}
        {error && (
          <div className="p-3.5 bg-red-500/10 dark:bg-red-950/40 border border-red-500/30 dark:border-red-900/60 rounded-xl text-xs text-red-600 dark:text-red-300 flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={clearError}
              className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white text-xs underline ml-2"
            >
              {t('common.close', 'Dismiss')}
            </button>
          </div>
        )}

        {statusMessage && (
          <div className="p-3.5 bg-blue-500/10 dark:bg-blue-950/40 border border-blue-500/40 rounded-xl text-xs text-blue-600 dark:text-blue-300 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-600 dark:text-blue-400 flex-shrink-0" />
                <span className="font-semibold">{statusMessage}</span>
              </div>
              {(downloadProgress !== null || uploadProgress !== null) && (
                <span className="font-mono text-[11px] font-bold">
                  {downloadProgress ?? uploadProgress ?? 0}%
                </span>
              )}
            </div>
            {(downloadProgress !== null || uploadProgress !== null) && (
              <div className="w-full bg-blue-200 dark:bg-blue-900/50 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-blue-600 dark:bg-blue-400 h-full transition-all duration-150 rounded-full"
                  style={{ width: `${Math.max(5, downloadProgress ?? uploadProgress ?? 0)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {/* ── NOT CONNECTED / SESSION EXPIRED VIEW ────────────────────────── */}
        {!isConnected ? (
          <div className="space-y-6 text-center py-6">
            {isSessionExpired ? (
              <div className="max-w-md mx-auto p-4 sm:p-5 bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 rounded-2xl text-left space-y-3 shadow-sm">
                <div className="flex items-start space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
                    <AlertCircle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1">
                    <h3 className="text-sm font-bold text-amber-900 dark:text-amber-200">
                      {t('cloud.sessionExpiredTitle', 'Session Google Drive expirée')}
                    </h3>
                    <p className="text-xs text-amber-800/90 dark:text-amber-300/90 leading-relaxed">
                      {t(
                        'cloud.sessionExpiredDesc',
                        'Votre session Google Drive a expiré (durée standard de 1h). Cliquez sur le bouton ci-dessous pour renouveler la connexion en un clic.'
                      )}
                    </p>
                  </div>
                </div>

                <div className="pt-2 flex flex-col sm:flex-row items-center justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={disconnect}
                    className="w-full sm:w-auto px-3.5 py-2 rounded-xl text-xs font-semibold text-slate-600 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    {t('cloud.forgetAccount', 'Changer de compte')}
                  </button>
                  <button
                    type="button"
                    onClick={connect}
                    disabled={!hasClientId}
                    className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-500 text-white font-semibold text-xs transition-all shadow-md shadow-amber-600/20"
                  >
                    <Cloud className="w-4 h-4" />
                    <span>{t('cloud.reconnectButton', 'Se reconnecter à Google Drive')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="max-w-md mx-auto space-y-2">
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  {t('cloud.connectTitle')}
                </h3>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  {t('cloud.connectDesc')}
                </p>
              </div>
            )}

            {!hasClientId && (
              <div className="max-w-md mx-auto p-3.5 bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 rounded-xl text-left text-xs text-amber-700 dark:text-amber-300 space-y-1">
                <div className="font-semibold flex items-center space-x-1.5">
                  <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                  <span>{t('cloud.clientIdMissingTitle', 'Google Client ID Not Configured')}</span>
                </div>
                <p className="text-[11px] text-amber-800 dark:text-amber-300/80 leading-relaxed">
                  {t(
                    'cloud.clientIdMissingDesc',
                    'To connect Google Drive, configure VITE_GOOGLE_CLIENT_ID in your .env file or container environment.'
                  )}
                </p>
              </div>
            )}

            {!isSessionExpired && (
              <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
                <button
                  type="button"
                  onClick={connect}
                  disabled={!hasClientId}
                  className="w-full sm:w-auto inline-flex items-center justify-center space-x-2.5 px-6 py-3 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold text-sm transition-all shadow-lg shadow-blue-600/25"
                >
                  <Cloud className="w-4 h-4" />
                  <span>{t('cloud.connectButton')}</span>
                </button>
              </div>
            )}

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/[0.06] text-left text-xs text-slate-600 dark:text-slate-400 space-y-2">
              <div className="flex items-center space-x-2 text-slate-800 dark:text-slate-300 font-semibold">
                <Lock className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                <span>{t('cloud.zeroAccessTitle')}</span>
              </div>
              <p className="leading-relaxed">{t('cloud.zeroAccessDesc')}</p>
            </div>
          </div>
        ) : (
          /* ── CONNECTED VIEW ─────────────────────────────────────────── */
          <div className="space-y-5">
            {/* Settings Panel */}
            {showSettings && (
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/[0.1] space-y-4 animate-in slide-in-from-top-2 shadow-sm">
                {/* 1. Client-Side Encryption Toggle */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <Lock className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                      {t('cloud.encryptionSettings', 'Client-Side Encryption')}
                    </h3>
                  </div>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={encToggle}
                        onChange={() => setEncToggle(!encToggle)}
                      />
                      <div
                        className={`block w-10 h-6 rounded-full transition-colors ${
                          encToggle ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
                        }`}
                      ></div>
                      <div
                        className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${
                          encToggle ? 'transform translate-x-4' : ''
                        }`}
                      ></div>
                    </div>
                  </label>
                </div>

                {encToggle && (
                  <div className="space-y-3 pt-2">
                    <p className="text-xs text-amber-700 dark:text-amber-400/90 leading-relaxed bg-amber-50 dark:bg-amber-500/10 p-2.5 rounded-lg border border-amber-200 dark:border-amber-500/20">
                      <strong>Warning:</strong>{' '}
                      {t(
                        'cloud.encryptionWarning',
                        'If you lose your password, your encrypted backups cannot be recovered.'
                      )}
                    </p>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                          {t('cloud.encryptionPassword', 'Encryption Password')}
                        </label>
                        <input
                          type="password"
                          value={encPass}
                          onChange={(e) => setEncPass(e.target.value)}
                          placeholder="SuperSecretPassword"
                          className="w-full bg-white dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label className="text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                          {t('cloud.rememberPassword', 'Remember Password')}
                        </label>
                        <select
                          value={encDuration}
                          onChange={(e) => setEncDuration(Number(e.target.value))}
                          className="w-full bg-white dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-3 py-2 text-xs text-slate-900 dark:text-slate-200 focus:border-blue-500 focus:outline-none"
                        >
                          <option value={0}>{t('cloud.sessionOnly', "Only this session (Don't save)")}</option>
                          <option value={86400000}>{t('cloud.oneDay', '1 Day')}</option>
                          <option value={604800000}>{t('cloud.oneWeek', '1 Week')}</option>
                          <option value={2592000000}>{t('cloud.oneMonth', '1 Month')}</option>
                          <option value={31536000000}>{t('cloud.oneYear', '1 Year')}</option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                {/* 2. Cross-Device Notifications Toggle */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-white/[0.08]">
                  <div className="space-y-0.5 max-w-[80%]">
                    <div className="flex items-center space-x-2">
                      <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                      <h4 className="text-xs font-semibold text-slate-900 dark:text-white">
                        {t('cloud.crossDeviceNotifications', 'Cross-Device Notifications')}
                      </h4>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {t(
                        'cloud.crossDeviceNotificationsDesc',
                        'Show a notification badge when new backups are uploaded from your other devices.'
                      )}
                    </p>
                  </div>
                  <label className="flex items-center cursor-pointer">
                    <div className="relative">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={notifsToggle}
                        onChange={() => setNotifsToggle(!notifsToggle)}
                      />
                      <div
                        className={`block w-10 h-6 rounded-full transition-colors ${
                          notifsToggle ? 'bg-blue-600' : 'bg-slate-300 dark:bg-slate-700'
                        }`}
                      ></div>
                      <div
                        className={`dot absolute left-1 top-1 bg-white w-4 h-4 rounded-full transition-transform ${
                          notifsToggle ? 'transform translate-x-4' : ''
                        }`}
                      ></div>
                    </div>
                  </label>
                </div>

                <div className="flex justify-end pt-2">
                  <button
                    onClick={handleSaveSettings}
                    className="px-4 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded-lg text-xs font-semibold transition-colors"
                  >
                    {t('cloud.saveSettings', 'Save Settings')}
                  </button>
                </div>
              </div>
            )}

            {/* Hidden File Input for Direct Upload */}
            <input
              ref={directFileInputRef}
              type="file"
              accept=".jwlibrary,.jwlibrary.enc"
              className="hidden"
              onChange={handleDirectFileUpload}
            />

            {/* Backup Active Library Bar or Direct Upload Box */}
            {activeLibraryBytes ? (
              <div className="p-4 rounded-xl bg-gradient-to-r from-blue-500/10 via-emerald-500/5 to-transparent border border-blue-500/25 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <span
                      className="text-xs font-bold text-slate-900 dark:text-white flex items-center space-x-1.5"
                      title="Active library"
                    >
                      <span>{t('cloud.saveActiveTitle', 'Save Active Library to Cloud')}</span>
                      {encryptionEnabled && <Lock className="w-3 h-3 text-amber-500" />}
                      {isCurrentInCloud && (
                        <span className="inline-flex items-center space-x-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                          <CheckCircle2 className="w-3 h-3 text-emerald-500" />
                          <span>{t('cloud.alreadyInCloud', 'Already Saved in Cloud ✓')}</span>
                        </span>
                      )}
                    </span>
                    <span
                      className="text-[11px] text-slate-500 dark:text-slate-400 block truncate max-w-xs sm:max-w-md cursor-help"
                      title={summary?.name}
                    >
                      {summary?.name} • {summary?.notesCount} {t('nav.notes', 'notes')} •{' '}
                      {summary?.tagsCount} {t('nav.tags', 'tags')}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleUploadClick}
                    disabled={isUploading}
                    className={`inline-flex items-center space-x-1.5 px-4 py-2 rounded-lg text-white text-xs font-semibold transition-all shadow-md disabled:opacity-50 ${
                      isCurrentInCloud
                        ? 'bg-slate-700 hover:bg-slate-600'
                        : 'bg-blue-600 hover:bg-blue-500 shadow-blue-600/20'
                    }`}
                  >
                    {encryptionEnabled ? (
                      <Lock className="w-3.5 h-3.5" />
                    ) : (
                      <Upload className="w-3.5 h-3.5" />
                    )}
                    <span>
                      {isUploading
                        ? t('cloud.uploading', 'Uploading...')
                        : encryptionEnabled
                        ? t('cloud.encryptAndUpload', 'Encrypt & Upload')
                        : t('cloud.backupNow', 'Save to Drive')}
                    </span>
                  </button>
                </div>

                <div className="pt-2 border-t border-blue-500/15 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => directFileInputRef.current?.click()}
                    disabled={isUploading}
                    className="text-[11px] text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-medium inline-flex items-center space-x-1.5 transition-colors disabled:opacity-50"
                  >
                    <Upload className="w-3 h-3" />
                    <span>{t('cloud.uploadDirectFileLink', 'Or upload another .jwlibrary file from disk')}</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-slate-50 dark:bg-white/[0.02] border border-dashed border-slate-300 dark:border-white/[0.1] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-400 flex items-center justify-center flex-shrink-0">
                    <Upload className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-slate-900 dark:text-white">
                      {t('cloud.uploadDirectFile', 'Upload .jwlibrary File')}
                    </h4>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {t('cloud.uploadDirectFileDesc', 'Directly upload and analyze a backup file from your computer.')}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => directFileInputRef.current?.click()}
                  disabled={isUploading}
                  className="inline-flex items-center justify-center space-x-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md shadow-blue-600/20 transition-all disabled:opacity-50 flex-shrink-0"
                >
                  <Upload className="w-3.5 h-3.5" />
                  <span>{t('cloud.chooseFile', 'Choose .jwlibrary')}</span>
                </button>
              </div>
            )}

            {/* Controls Bar: Search, Sort, Batch Actions */}
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5">
                {/* Search input */}
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t('cloud.searchPlaceholder', 'Search cloud backups by name...')}
                    className="w-full bg-slate-50 dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl pl-9 pr-3.5 py-2 text-xs text-slate-900 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-blue-500"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {/* Sort dropdown */}
                <div className="flex items-center space-x-2">
                  <div className="flex items-center space-x-1 text-xs text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-[#0b0f17] border border-slate-300 dark:border-white/[0.1] rounded-xl px-2.5 py-1.5">
                    <ArrowUpDown className="w-3.5 h-3.5 text-slate-400" />
                    <select
                      aria-label="Sort backups"
                      value={sortOrder}
                      onChange={(e) => setSortOrder(e.target.value as 'newest' | 'oldest')}
                      className="bg-transparent text-slate-800 dark:text-slate-300 text-xs focus:outline-none cursor-pointer"
                    >
                      <option
                        value="newest"
                        className="bg-white dark:bg-[#0e1422] text-slate-900 dark:text-slate-100"
                      >
                        {t('cloud.newestFirst', 'Newest First')}
                      </option>
                      <option
                        value="oldest"
                        className="bg-white dark:bg-[#0e1422] text-slate-900 dark:text-slate-100"
                      >
                        {t('cloud.oldestFirst', 'Oldest First')}
                      </option>
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => directFileInputRef.current?.click()}
                    disabled={isUploading}
                    className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-xl bg-blue-500/10 hover:bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-500/30 text-xs font-semibold transition-colors disabled:opacity-50"
                    title={t('cloud.uploadDirectFile', 'Upload .jwlibrary File')}
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">{t('cloud.uploadDirectBtn', 'Upload .jwlibrary')}</span>
                  </button>

                  <button
                    type="button"
                    onClick={refreshBackups}
                    disabled={isLoading}
                    className="p-2 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.03] dark:hover:bg-white/[0.08] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] transition-colors"
                    title={t('cloud.refreshList', 'Refresh list')}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-500' : ''}`} />
                  </button>
                </div>
              </div>

              {/* Batch Action Toolbar */}
              <div className="flex items-center justify-between flex-wrap gap-2 text-xs pt-1 pb-1">
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={selectAll}
                    className="flex items-center space-x-1.5 text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200 text-xs font-medium"
                  >
                    {selectedIds.length > 0 && selectedIds.length === filteredBackups.length ? (
                      <CheckSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                    ) : (
                      <Square className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                    )}
                    <span>
                      {t('cloud.selectAll', {
                        count: filteredBackups.length,
                        defaultValue: `Select All (${filteredBackups.length})`,
                      })}
                    </span>
                  </button>

                  {selectedIds.length > 0 && (
                    <span className="text-slate-500">
                      •{' '}
                      {t('cloud.selectedCount', {
                        count: selectedIds.length,
                        defaultValue: `${selectedIds.length} selected`,
                      })}
                    </span>
                  )}
                </div>

                <div className="flex items-center space-x-2">
                  {/* Merge 2 Selected Files */}
                  {selectedIds.length === 2 && (
                    <button
                      type="button"
                      onClick={handleMergeSelected}
                      className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs shadow-md shadow-blue-600/20 transition-all"
                    >
                      <GitMerge className="w-3.5 h-3.5" />
                      <span>{t('cloud.mergeSelected', 'Merge 2 Selected Files')}</span>
                    </button>
                  )}

                  {/* Batch Delete */}
                  {selectedIds.length > 0 && (
                    <button
                      type="button"
                      onClick={handleBatchDelete}
                      className="inline-flex items-center space-x-1 px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-300 border border-red-500/30 text-xs font-semibold transition-all"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>
                        {t('cloud.deleteSelected', {
                          count: selectedIds.length,
                          defaultValue: `Delete Selected (${selectedIds.length})`,
                        })}
                      </span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={disconnect}
                    className="text-slate-500 hover:text-red-500 text-xs underline pl-2"
                  >
                    {t('cloud.disconnect', 'Disconnect')}
                  </button>
                </div>
              </div>

              {/* Backups List */}
              {filteredBackups.length === 0 ? (
                <div className="text-center py-10 border border-slate-200 dark:border-white/[0.06] rounded-xl bg-slate-50 dark:bg-white/[0.01] space-y-2">
                  <HardDrive className="w-8 h-8 text-slate-400 dark:text-slate-600 mx-auto" />
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {searchQuery
                      ? t('cloud.noBackupsMatch', 'No backups match your search query.')
                      : t('cloud.noBackupsFound', 'No backups found in Google Drive yet.')}
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[350px] overflow-y-auto pr-1">
                  {filteredBackups.map((b) => {
                    const isSelected = selectedIds.includes(b.id);
                    const isEncrypted = b.name.endsWith('.enc');
                    const isFromOther = b.deviceId && b.deviceId !== myDeviceId;

                    return (
                      <div
                        key={b.id}
                        className={`p-3 rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between text-xs transition-colors gap-3 ${
                          isSelected
                            ? 'bg-blue-500/10 border-blue-500/40'
                            : 'bg-slate-50 hover:bg-slate-100 dark:bg-white/[0.02] dark:hover:bg-white/[0.04] border-slate-200 dark:border-white/[0.06]'
                        }`}
                      >
                        <div className="flex items-center space-x-3 truncate max-w-full sm:max-w-[65%]">
                          <button
                            type="button"
                            onClick={() => toggleSelect(b.id)}
                            className="p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-white flex-shrink-0"
                          >
                            {isSelected ? (
                              <CheckSquare className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                            ) : (
                              <Square className="w-4 h-4 text-slate-400 dark:text-slate-500" />
                            )}
                          </button>

                          <div className="space-y-0.5 truncate flex-1 min-w-0">
                            <div
                              className="font-semibold text-slate-800 dark:text-slate-200 truncate flex items-center space-x-1.5 cursor-help"
                              title={isEncrypted ? `${b.name} (${t('cloud.encryptedBadge', 'Encrypted')})` : b.name}
                            >
                              {isEncrypted && (
                                <Lock className="w-3 h-3 text-amber-500 flex-shrink-0" />
                              )}
                              <span className="truncate" title={b.name}>{b.name}</span>
                              {b.isValidated === false && (
                                <span
                                  className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-[10px] font-medium flex-shrink-0"
                                  title={t('cloud.unverifiedTooltip', 'This backup has not been integrity-validated or may be incomplete.')}
                                >
                                  <AlertCircle className="w-2.5 h-2.5 text-amber-500" />
                                  <span>{t('cloud.unverifiedBadge', 'Unverified')}</span>
                                </span>
                              )}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 flex items-center space-x-2 flex-wrap">
                              <span>
                                {b.createdTime
                                  ? new Date(b.createdTime).toLocaleString()
                                  : t('cloud.recent', 'Recent')}
                              </span>
                              {b.size && <span>• {(parseInt(b.size, 10) / 1024).toFixed(1)} KB</span>}
                              {(b.notesCount !== undefined || b.tagsCount !== undefined || b.playlistsCount !== undefined || b.bookmarksCount !== undefined) && (
                                <span className="inline-flex items-center space-x-2 text-slate-600 dark:text-slate-300 font-medium">
                                  <span>•</span>
                                  {b.notesCount !== undefined && (
                                    <span className="inline-flex items-center space-x-0.5">
                                      <FileText className="w-3 h-3 text-blue-500" />
                                      <span>{b.notesCount} {t('nav.notes', 'notes')}</span>
                                    </span>
                                  )}
                                  {b.tagsCount !== undefined && (
                                    <span className="inline-flex items-center space-x-0.5">
                                      <Tag className="w-3 h-3 text-emerald-500" />
                                      <span>{b.tagsCount} {t('nav.tags', 'tags')}</span>
                                    </span>
                                  )}
                                  {b.playlistsCount !== undefined && (
                                    <span className="inline-flex items-center space-x-0.5">
                                      <ListMusic className="w-3 h-3 text-purple-500" />
                                      <span>{b.playlistsCount} {t('nav.playlists', 'playlists')}</span>
                                    </span>
                                  )}
                                  {b.bookmarksCount !== undefined && (
                                    <span className="inline-flex items-center space-x-0.5">
                                      <Bookmark className="w-3 h-3 text-amber-500" />
                                      <span>{b.bookmarksCount} {t('stats.bookmarks', 'bookmarks')}</span>
                                    </span>
                                  )}
                                </span>
                              )}
                              {isFromOther && (
                                <span className="inline-flex items-center space-x-1 px-1.5 py-0.2 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20 text-[10px] font-medium">
                                  <span>{t('cloud.fromOtherDevice', 'From another device')}</span>
                                  {b.deviceName && <span>({b.deviceName})</span>}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center space-x-1.5 flex-shrink-0 self-end sm:self-auto">
                          {/* 1. Open / Load into App Workspace */}
                          <button
                            type="button"
                            onClick={() => handleRestoreClick(b)}
                            disabled={isLoading || downloadingFileId !== null}
                            className={`inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all shadow-sm ${
                              isEncrypted
                                ? 'bg-amber-500/15 hover:bg-amber-500/25 text-amber-700 dark:text-amber-300 border border-amber-500/30'
                                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20'
                            }`}
                            title={t('cloud.openInAppTooltip', 'Load this backup into the app workspace (Merge, Explorer, Stats)')}
                          >
                            {isEncrypted ? (
                              <Unlock className="w-3.5 h-3.5" />
                            ) : (
                              <FolderOpen className="w-3.5 h-3.5" />
                            )}
                            <span>
                              {isEncrypted
                                ? t('cloud.openInAppEncrypted', 'Unlock & Open')
                                : t('cloud.openInApp', 'Open in App')}
                            </span>
                          </button>

                          {/* 2. Download directly to Device */}
                          <button
                            type="button"
                            onClick={() => handleDownloadToDevice(b)}
                            disabled={isLoading || downloadingFileId !== null}
                            className="inline-flex items-center space-x-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-white/[0.12] bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.05] dark:hover:bg-white/[0.1] text-slate-700 dark:text-slate-200 text-xs font-semibold transition-colors shadow-sm"
                            title={t('cloud.downloadToDeviceTooltip', 'Save decrypted .jwlibrary file directly to your device')}
                          >
                            {downloadingFileId === b.id ? (
                              <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500" />
                            ) : (
                              <Download className="w-3.5 h-3.5" />
                            )}
                            <span>{t('cloud.downloadToDevice', 'Download')}</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleStartRename(b)}
                            disabled={isLoading || isRenaming}
                            className="p-1.5 text-slate-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                            title={t('cloud.rename', 'Rename')}
                            aria-label={t('cloud.rename', 'Rename')}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              if (
                                window.confirm(
                                  t('cloud.confirmDeleteOne', {
                                    name: b.name,
                                    defaultValue: `Delete "${b.name}" from Google Drive?`,
                                  })
                                )
                              ) {
                                deleteCloudBackup(b.id);
                              }
                            }}
                            className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                            title={t('cloud.deleteFromCloud', 'Delete from Google Drive')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
