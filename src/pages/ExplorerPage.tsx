import React, { useState, useMemo, useRef } from 'react';
import {
  Search,
  Tag,
  BookOpen,
  Filter,
  ExternalLink,
  Sparkles,
  Edit3,
  Trash2,
  Stethoscope,
  Download,
  CheckCircle2,
  AlertCircle,
  Plus,
  Upload,
  Cloud,
  X,
  ChevronDown,
  ChevronRight,
  FileText,
  Bookmark as BookmarkIcon,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { useCloudStore } from '../store/useCloudStore';
import { queryAll, execute, exportDatabase } from '../lib/jw/sqlite';
import { runHealthChecks, applyHealthFix } from '../lib/jw/doctor';
import { BIBLE_BOOKS, getJwBibleLink, getJwPubLink } from '../lib/jw/locales';
import { HIGHLIGHT_COLORS } from '../lib/jw/tokenizer';
import { createOrUpdateManifest } from '../lib/jw/manifest';
import { packageJwLibrary } from '../lib/jw/zip';
import { IHealthCheckResult } from '../lib/jw/types';
import { useTranslation } from 'react-i18next';

interface INoteCardItem {
  noteId: number;
  guid: string;
  title: string | null;
  content: string | null;
  lastModified: string;
  created: string;
  locationId: number | null;
  locationTitle: string | null;
  bookNumber: number | null;
  chapterNumber: number | null;
  keySymbol: string | null;
  issueTagNumber: number | null;
  userMarkId: number | null;
  colorIndex: number | null;
  tags: string[];
}

interface IPlaylistCardItem {
  id: number;
  name: string;
  itemCount: number;
  items: string[];
}

export interface IBookmarkCardItem {
  bookmarkId: number;
  slot: number;
  title: string;
  snippet: string | null;
  blockType: number;
  blockIdentifier: number | null;
  locationId: number;
  locationTitle: string | null;
  bookNumber: number | null;
  chapterNumber: number | null;
  keySymbol: string | null;
  issueTagNumber: number | null;
  documentId: number | null;
  track: number | null;
  pubLocationId: number | null;
  pubKeySymbol: string | null;
  pubTitle: string | null;
}

export const ExplorerPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    activeDb,
    activeManifest,
    activeLibraryFile,
    summary,
    selectedLanguage,
    updateActiveDatabase,
    loadDemoLibrary,
    isLoading,
    activeSha256,
    extraFiles,
  } = useAppStore();

  const {
    setShowCloudModal,
    isConnected,
    isShaInCloud,
    backupCurrentLibrary,
    isUploading,
  } = useCloudStore();
  const isCurrentInCloud = activeSha256 ? isShaInCloud(activeSha256) : false;

  const handleDirectCloudUpload = async () => {
    try {
      await backupCurrentLibrary();
    } catch (_) {}
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'all' | 'notes' | 'highlights' | 'bookmarks' | 'playlists'>('all');

  // Collapsible categories
  const [showNotesCategory, setShowNotesCategory] = useState<boolean>(true);
  const [showPlaylistsCategory, setShowPlaylistsCategory] = useState<boolean>(true);
  const [showBookmarksCategory, setShowBookmarksCategory] = useState<boolean>(true);

  // Edit Note State
  const [editingNote, setEditingNote] = useState<INoteCardItem | null>(null);
  const [editTitle, setEditTitle] = useState<string>('');
  const [editContent, setEditContent] = useState<string>('');

  // Doctor Drawer State
  const [showDoctor, setShowDoctor] = useState<boolean>(false);
  const [doctorResults, setDoctorResults] = useState<IHealthCheckResult[]>([]);

  // Tag Manager Modal State
  const [showTagManager, setShowTagManager] = useState<boolean>(false);
  const [renamingTag, setRenamingTag] = useState<{ id: number; name: string } | null>(null);
  const [newTagName, setNewTagName] = useState<string>('');

  // ── Query All Notes from Database ───────────────────────────────────────
  const allNotes: INoteCardItem[] = useMemo(() => {
    if (!activeDb) return [];

    try {
      const sql = `
        SELECT 
          n.NoteId AS noteId,
          n.Guid AS guid,
          n.Title AS title,
          n.Content AS content,
          n.LastModified AS lastModified,
          n.Created AS created,
          n.LocationId AS locationId,
          l.Title AS locationTitle,
          l.BookNumber AS bookNumber,
          l.ChapterNumber AS chapterNumber,
          l.KeySymbol AS keySymbol,
          l.IssueTagNumber AS issueTagNumber,
          n.UserMarkId AS userMarkId,
          um.ColorIndex AS colorIndex
        FROM Note n
        LEFT JOIN Location l ON n.LocationId = l.LocationId
        LEFT JOIN UserMark um ON n.UserMarkId = um.UserMarkId
        ORDER BY n.LastModified DESC
      `;

      const rawNotes = queryAll<any>(activeDb, sql);

      // Query tags for each note
      const tagSql = `
        SELECT tm.NoteId, t.Name
        FROM TagMap tm
        JOIN Tag t ON tm.TagId = t.TagId
        WHERE tm.NoteId IS NOT NULL
      `;
      const rawTags = queryAll<{ NoteId: number; Name: string }>(activeDb, tagSql);
      const tagMap = new Map<number, string[]>();
      for (const t of rawTags) {
        const list = tagMap.get(t.NoteId) || [];
        list.push(t.Name);
        tagMap.set(t.NoteId, list);
      }

      return rawNotes.map((n) => ({
        ...n,
        tags: tagMap.get(n.noteId) || [],
      }));
    } catch (err) {
      console.error('Error fetching notes:', err);
      return [];
    }
  }, [activeDb, summary]);

  // Query all distinct tags
  const allTags = useMemo(() => {
    if (!activeDb) return [];
    try {
      return queryAll<{ TagId: number; Name: string; count: number }>(
        activeDb,
        `SELECT t.TagId, t.Name, COUNT(tm.TagMapId) AS count 
         FROM Tag t 
         LEFT JOIN TagMap tm ON t.TagId = tm.TagId 
         WHERE t.Type = 1
         GROUP BY t.TagId, t.Name 
         ORDER BY count DESC, t.Name ASC`
      );
    } catch (_) {
      return [];
    }
  }, [activeDb, summary]);

  // ── Query Playlists ──────────────────────────────────────────────────
  const playlists: IPlaylistCardItem[] = useMemo(() => {
    if (!activeDb) return [];
    try {
      const sql = `
        SELECT 
          t.TagId AS id, 
          t.Name AS name, 
          COUNT(tm.PlaylistItemId) AS itemCount,
          GROUP_CONCAT(pl.Label, '||') AS items
        FROM Tag t
        JOIN TagMap tm ON tm.TagId = t.TagId
        JOIN PlaylistItem pl ON pl.PlaylistItemId = tm.PlaylistItemId
        WHERE t.Type = 2
        GROUP BY t.TagId
        ORDER BY t.Name COLLATE NOCASE ASC
      `;
      const raw = queryAll<any>(activeDb, sql);
      return raw.map(r => ({
        id: r.id,
        name: r.name,
        itemCount: r.itemCount,
        items: r.items ? r.items.split('||') : []
      }));
    } catch (err) {
      console.error('Error fetching playlists:', err);
      return [];
    }
  }, [activeDb, summary]);

  const filteredPlaylists = useMemo(() => {
    return playlists.filter((p) => {
      const matchSearch =
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.items.some((i) => i.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchTag = selectedTag ? p.name === selectedTag : true;
      return matchSearch && matchTag;
    });
  }, [playlists, searchQuery, selectedTag]);

  // ── Query Bookmarks ──────────────────────────────────────────────────
  const bookmarks: IBookmarkCardItem[] = useMemo(() => {
    if (!activeDb) return [];
    try {
      const sql = `
        SELECT 
          bm.BookmarkId AS bookmarkId,
          bm.Slot AS slot,
          bm.Title AS title,
          bm.Snippet AS snippet,
          bm.BlockType AS blockType,
          bm.BlockIdentifier AS blockIdentifier,
          bm.LocationId AS locationId,
          l.Title AS locationTitle,
          l.BookNumber AS bookNumber,
          l.ChapterNumber AS chapterNumber,
          l.KeySymbol AS keySymbol,
          l.IssueTagNumber AS issueTagNumber,
          l.DocumentId AS documentId,
          l.Track AS track,
          bm.PublicationLocationId AS pubLocationId,
          pl.KeySymbol AS pubKeySymbol,
          pl.Title AS pubTitle
        FROM Bookmark bm
        LEFT JOIN Location l ON bm.LocationId = l.LocationId
        LEFT JOIN Location pl ON bm.PublicationLocationId = pl.LocationId
        ORDER BY bm.Slot ASC, bm.BookmarkId ASC
      `;
      return queryAll<IBookmarkCardItem>(activeDb, sql);
    } catch (err) {
      console.error('Error fetching bookmarks:', err);
      return [];
    }
  }, [activeDb, summary]);

  const groupedBookmarks = useMemo(() => {
    const map = new Map<
      string,
      {
        title: string;
        isBible: boolean;
        bookNumber: number | null;
        keySymbol: string | null;
        items: IBookmarkCardItem[];
      }
    >();

    for (const bm of bookmarks) {
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matches =
          (bm.title && bm.title.toLowerCase().includes(q)) ||
          (bm.snippet && bm.snippet.toLowerCase().includes(q)) ||
          (bm.locationTitle && bm.locationTitle.toLowerCase().includes(q)) ||
          (bm.pubTitle && bm.pubTitle.toLowerCase().includes(q)) ||
          (bm.bookNumber && BIBLE_BOOKS[bm.bookNumber]?.toLowerCase().includes(q));
        if (!matches) continue;
      }

      let groupKey: string;
      let groupTitle: string;
      let isBible = false;

      if (bm.bookNumber) {
        groupKey = `bible_${bm.bookNumber}`;
        groupTitle = BIBLE_BOOKS[bm.bookNumber] || `Bible Book #${bm.bookNumber}`;
        isBible = true;
      } else if (bm.keySymbol || bm.pubKeySymbol) {
        const sym = bm.pubKeySymbol || bm.keySymbol || 'pub';
        groupKey = `pub_${sym}`;
        groupTitle = bm.pubTitle || bm.locationTitle || sym;
      } else {
        groupKey = 'general';
        groupTitle = bm.locationTitle || 'General Bookmarks';
      }

      if (!map.has(groupKey)) {
        map.set(groupKey, {
          title: groupTitle,
          isBible,
          bookNumber: bm.bookNumber,
          keySymbol: bm.keySymbol || bm.pubKeySymbol,
          items: [],
        });
      }
      map.get(groupKey)!.items.push(bm);
    }

    return Array.from(map.values());
  }, [bookmarks, searchQuery]);

  // ── Filtered Notes with Instant Text Search ──────────────────────────────
  const filteredNotes = useMemo(() => {
    let list = allNotes;

    // Type filter
    if (selectedType === 'highlights') {
      list = list.filter((n) => n.userMarkId !== null);
    } else if (selectedType === 'notes') {
      list = list.filter((n) => n.userMarkId === null);
    }

    // Tag filter
    if (selectedTag) {
      list = list.filter((n) => n.tags.includes(selectedTag));
    }

    // Search Query (Text Matching)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return list.filter(
        (n) =>
          (n.title && n.title.toLowerCase().includes(q)) ||
          (n.content && n.content.toLowerCase().includes(q)) ||
          (n.locationTitle && n.locationTitle.toLowerCase().includes(q)) ||
          n.tags.some((t) => t.toLowerCase().includes(q))
      );
    }

    return list;
  }, [allNotes, selectedType, selectedTag, searchQuery]);

  // ── Edit Note Handlers ──────────────────────────────────────────────────
  const startEditNote = (note: INoteCardItem) => {
    setEditingNote(note);
    setEditTitle(note.title || '');
    setEditContent(note.content || '');
  };

  const saveEditedNote = async () => {
    if (!activeDb || !editingNote || !activeManifest) return;

    const nowIso = new Date().toISOString();
    execute(
      activeDb,
      'UPDATE Note SET Title = :t, Content = :c, LastModified = :lm WHERE NoteId = :id',
      {
        ':t': editTitle,
        ':c': editContent,
        ':lm': nowIso,
        ':id': editingNote.noteId,
      }
    );

    const newBytes = exportDatabase(activeDb);
    await updateActiveDatabase(newBytes);
    setEditingNote(null);
  };

  const deleteNote = async (noteId: number) => {
    if (!activeDb || !window.confirm(t('explorer.confirmDeleteNote', 'Are you sure you want to delete this note?'))) return;
    execute(activeDb, 'DELETE FROM TagMap WHERE NoteId = :id', { ':id': noteId });
    execute(activeDb, 'DELETE FROM Note WHERE NoteId = :id', { ':id': noteId });

    const newBytes = exportDatabase(activeDb);
    await updateActiveDatabase(newBytes);
  };

  // ── Export Updated .jwlibrary ───────────────────────────────────────────
  const handleDownloadUpdatedBackup = async () => {
    if (!activeDb || !activeManifest) return;
    const dbBytes = exportDatabase(activeDb);
    const updatedManifest = await createOrUpdateManifest(dbBytes, activeManifest);
    const rawBlob = await packageJwLibrary(dbBytes, updatedManifest, extraFiles);
    const blob = rawBlob.type === 'application/octet-stream' ? rawBlob : new Blob([rawBlob], { type: 'application/octet-stream' });

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(updatedManifest.name || 'study_library').replace(/[^a-z0-9_\-]/gi, '_')}.jwlibrary`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── Library Doctor Handlers ─────────────────────────────────────────────
  const openDoctor = () => {
    if (!activeDb) return;
    const checks = runHealthChecks(activeDb);
    setDoctorResults(checks);
    setShowDoctor(true);
  };

  const fixDoctorIssue = async (key: string, affectedIds: number[]) => {
    if (!activeDb) return;
    applyHealthFix(activeDb, key, affectedIds);
    const newBytes = exportDatabase(activeDb);
    await updateActiveDatabase(newBytes);
    const checks = runHealthChecks(activeDb);
    setDoctorResults(checks);
  };

  // ── Tag Manager Handlers ────────────────────────────────────────────────
  const handleRenameTag = async () => {
    if (!activeDb || !renamingTag || !newTagName.trim()) return;
    execute(activeDb, 'UPDATE Tag SET Name = :name WHERE TagId = :id', {
      ':name': newTagName.trim(),
      ':id': renamingTag.id,
    });
    const newBytes = exportDatabase(activeDb);
    await updateActiveDatabase(newBytes);
    setRenamingTag(null);
    setNewTagName('');
  };

  const handleDeleteTag = async (tagId: number) => {
    if (!activeDb || !window.confirm(t('explorer.confirmDeleteTag', 'Delete this tag? (Notes will not be deleted)'))) return;
    execute(activeDb, 'DELETE FROM TagMap WHERE TagId = :id', { ':id': tagId });
    execute(activeDb, 'DELETE FROM Tag WHERE TagId = :id', { ':id': tagId });
    const newBytes = exportDatabase(activeDb);
    await updateActiveDatabase(newBytes);
  };

  // Empty state if no library loaded
  if (!activeDb || !summary) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-20 text-center space-y-6">
        <div className="w-16 h-16 rounded-3xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400 mx-auto">
          <BookOpen className="w-8 h-8" />
        </div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('explorer.noLibraryLoaded')}</h1>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            {t('explorer.noLibraryPrompt')}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3 pt-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-3 rounded-2xl bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs tracking-wide transition-all shadow-md shadow-blue-600/30"
          >
            <Upload className="w-4 h-4" />
            <span>{t('explorer.openFileBtn', 'Open .jwlibrary File')}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".jwlibrary"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await useAppStore.getState().loadLibrary(file);
            }}
          />
          <button
            type="button"
            onClick={() => useCloudStore.getState().setShowCloudModal(true)}
            className="w-full sm:w-auto inline-flex items-center justify-center space-x-2 px-5 py-3 rounded-2xl bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.04] dark:hover:bg-white/[0.08] text-slate-800 dark:text-slate-200 border border-slate-200 dark:border-white/[0.08] text-xs font-semibold transition-all shadow-sm"
          >
            <Cloud className="w-4 h-4 text-blue-500" />
            <span>{t('merge.chooseFromDrive', 'Choose from Google Drive')}</span>
          </button>
        </div>

        <div className="pt-4">
          <button
            type="button"
            onClick={loadDemoLibrary}
            disabled={isLoading}
            className="inline-flex items-center space-x-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 font-medium underline"
          >
            <Sparkles className="w-3.5 h-3.5 text-blue-500" />
            <span>{t('explorer.tryDemoBtn', 'Try Demo Library')}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* ── TOP ACTION BAR ─────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-4 border-b border-slate-200 dark:border-slate-800 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white flex items-center space-x-2">
            <span>{t('nav.explorer')}</span>
            <span className="text-xs px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 font-normal">
              {filteredNotes.length} / {allNotes.length} {t('nav.notes')}
            </span>
          </h1>
          <p
            className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 truncate max-w-[280px] sm:max-w-md lg:max-w-xl cursor-help"
            title={activeLibraryFile instanceof File && activeLibraryFile.name && activeLibraryFile.name !== summary.name
              ? `${summary.name} (${activeLibraryFile.name}) • ${summary.deviceName}`
              : `${summary.name} • ${summary.deviceName}`}
          >
            {summary.name} • {summary.deviceName}
          </p>
        </div>

        <div className="flex items-center space-x-2 flex-wrap">
          <button
            type="button"
            onClick={() => setShowTagManager(true)}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-medium transition-colors shadow-sm"
          >
            <Tag className="w-3.5 h-3.5 text-sky-500 dark:text-sky-400" />
            <span>{t('explorer.tagManagerBtn')} ({allTags.length})</span>
          </button>

          <button
            type="button"
            onClick={openDoctor}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 text-xs font-medium transition-colors shadow-sm"
          >
            <Stethoscope className="w-3.5 h-3.5 text-teal-500 dark:text-teal-400" />
            <span>{t('explorer.doctorBtn')}</span>
          </button>

          {/* Google Drive Status & Upload Button */}
          {isConnected ? (
            isCurrentInCloud ? (
              <button
                type="button"
                onClick={() => setShowCloudModal(true)}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md border text-xs font-medium bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border-emerald-500/30 transition-colors shadow-sm"
                title="Manage Cloud Backups"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                <span>{t('cloud.inCloudBadge', 'Saved in Cloud ✓')}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDirectCloudUpload}
                disabled={isUploading}
                className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-all disabled:opacity-50"
                title={t('nav.uploadToDrive', 'Upload to Drive')}
              >
                <Upload className={`w-3.5 h-3.5 ${isUploading ? 'animate-bounce' : ''}`} />
                <span>{isUploading ? t('cloud.uploading', 'Uploading...') : t('nav.uploadToDrive', 'Upload to Drive')}</span>
              </button>
            )
          ) : null}

          <button
            type="button"
            onClick={() => setShowCloudModal(true)}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-white/[0.03] dark:hover:bg-white/[0.06] text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/[0.08] text-xs font-medium transition-colors shadow-sm"
          >
            <Cloud className="w-3.5 h-3.5 text-teal-500 dark:text-teal-400" />
            <span>{t('explorer.cloudDriveBtn')}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadUpdatedBackup}
            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold transition-colors shadow-sm"
          >
            <Download className="w-4 h-4" />
            <span>{t('explorer.saveBackupBtn')}</span>
          </button>
        </div>
      </div>

      {/* ── SEARCH & FILTER CONTROLS ───────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Search input + AI toggle */}
        <div className="md:col-span-3 flex items-center space-x-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder={t('explorer.searchPlaceholder', 'Search notes, scriptures, tags...')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-slate-500 focus:outline-none focus:border-emerald-500 shadow-sm"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* Type Filter dropdown */}
        <div className="flex items-center space-x-2">
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as any)}
            className="w-full py-2 px-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg text-xs text-slate-700 dark:text-slate-300 focus:outline-none focus:border-emerald-500 shadow-sm"
          >
            <option value="all">{t('explorer.filterAll')} ({allNotes.length + playlists.length + bookmarks.length})</option>
            <option value="notes">{t('explorer.filterNotes')}</option>
            <option value="bookmarks">{t('explorer.filterBookmarks')} ({bookmarks.length})</option>
            <option value="playlists">{t('explorer.filterPlaylists')} ({playlists.length})</option>
          </select>
        </div>
      </div>

      {/* ── 1. NOTES (TAGS + NOTES) CATEGORY (FOLDABLE) ───────────────── */}
      {(selectedType === 'all' || selectedType === 'notes' || selectedType === 'highlights') && (
        <div className="mb-8">
          <button
            type="button"
            onClick={() => setShowNotesCategory(!showNotesCategory)}
            className="flex items-center space-x-2 w-full text-left focus:outline-none group mb-4"
          >
            {showNotesCategory ? (
              <ChevronDown className="w-5 h-5 text-amber-500 dark:text-amber-400 group-hover:text-amber-600 dark:group-hover:text-amber-300" />
            ) : (
              <ChevronRight className="w-5 h-5 text-amber-500 dark:text-amber-400 group-hover:text-amber-600 dark:group-hover:text-amber-300" />
            )}
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center space-x-2">
              <FileText className="w-5 h-5 text-amber-500 dark:text-amber-400" />
              <span>{t('explorer.notesCategory', 'Notes')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">({filteredNotes.length})</span>
            </h2>
          </button>

          {showNotesCategory && (
            <div className="space-y-4">
              {/* Tag pills filter list */}
              {allTags.length > 0 && (
                <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar py-1 text-xs">
                  <button
                    type="button"
                    onClick={() => setSelectedTag(null)}
                    className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors ${
                      selectedTag === null
                        ? 'bg-amber-600 text-white font-medium shadow-sm'
                        : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
                    }`}
                  >
                    {t('explorer.allTags', 'All Tags')}
                  </button>
                  {allTags.map((tItem) => (
                    <button
                      key={tItem.TagId}
                      type="button"
                      onClick={() => setSelectedTag(tItem.Name === selectedTag ? null : tItem.Name)}
                      className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors flex items-center space-x-1 ${
                        selectedTag === tItem.Name
                          ? 'bg-amber-600 text-white font-medium shadow-sm'
                          : 'bg-slate-100 dark:bg-slate-900 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-800'
                      }`}
                    >
                      <span>{tItem.Name}</span>
                      <span className="text-[10px] opacity-75 font-mono">({tItem.count})</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Notes Grid */}
              {filteredNotes.length === 0 ? (
                <div className="text-center py-12 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-900/30 space-y-2">
                  <p className="text-sm text-slate-600 dark:text-slate-400">{t('explorer.noNotesMatched', 'No notes matched your current search and filters.')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setSelectedTag(null);
                      setSelectedType('all');
                    }}
                    className="text-xs text-amber-600 dark:text-amber-400 hover:underline font-semibold"
                  >
                    {t('explorer.clearAllFilters', 'Clear all filters')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {filteredNotes.map((note) => {
                    // Determine jw.org link
                    let jwLink: string | null = null;
                    if (note.bookNumber) {
                      jwLink = getJwBibleLink(
                        note.bookNumber,
                        note.chapterNumber,
                        null,
                        selectedLanguage
                      );
                    } else if (note.keySymbol) {
                      jwLink = getJwPubLink(
                        note.keySymbol,
                        note.issueTagNumber || undefined,
                        null,
                        null,
                        selectedLanguage
                      );
                    }

                    const colorInfo = note.colorIndex ? HIGHLIGHT_COLORS[note.colorIndex] : null;

                    return (
                      <div
                        key={note.noteId}
                        className="border border-slate-200 dark:border-slate-800 hover:border-amber-500/50 dark:hover:border-amber-500/40 bg-white dark:bg-slate-900 rounded-xl p-4 flex flex-col justify-between space-y-3 transition-colors shadow-sm group"
                      >
                        <div className="space-y-2">
                          {/* Location & Color Header */}
                          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                            <div className="flex items-center space-x-1.5 truncate max-w-[80%]">
                              {colorInfo && (
                                <span
                                  className={`w-2 h-2 rounded-full ${colorInfo.bgClass} ring-1 ${colorInfo.borderClass}`}
                                  title={`${t('stats.highlights', 'Highlight')}: ${t(`stats.color${colorInfo.name}`, colorInfo.name)} (${t(`stats.color${colorInfo.name}Cat`, colorInfo.category)})`}
                                />
                              )}
                              <span className="font-medium text-slate-700 dark:text-slate-300 truncate">
                                {note.locationTitle ||
                                  (note.bookNumber
                                    ? `${BIBLE_BOOKS[note.bookNumber] || 'Bible'} ch. ${note.chapterNumber || 1}`
                                    : t('explorer.personalNote', 'Personal Note'))}
                              </span>
                            </div>

                            {jwLink && (
                              <a
                                href={jwLink}
                                target="_blank"
                                rel="noreferrer"
                                className="text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 transition-colors p-1"
                                title="Open on JW.org"
                              >
                                <ExternalLink className="w-3.5 h-3.5" />
                              </a>
                            )}
                          </div>

                          {/* Note Title */}
                          {note.title && (
                            <h3 className="font-semibold text-sm text-slate-900 dark:text-white leading-snug">
                              {note.title}
                            </h3>
                          )}

                          {/* Note Content */}
                          <p className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-36 overflow-y-auto">
                            {note.content || <em className="text-slate-400 dark:text-slate-500">No content</em>}
                          </p>
                        </div>

                        {/* Bottom Footer: Tags, Date, Actions */}
                        <div className="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                          <div className="flex items-center space-x-1 flex-wrap gap-1">
                            {note.tags.map((tag) => (
                              <span
                                key={tag}
                                onClick={() => setSelectedTag(tag)}
                                className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-950 text-slate-600 dark:text-slate-400 hover:text-amber-500 dark:hover:text-amber-400 cursor-pointer border border-slate-200 dark:border-slate-800"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>

                          <div className="flex items-center space-x-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditNote(note)}
                              className="p-1 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
                              title="Edit note"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteNote(note.noteId)}
                              className="p-1 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                              title="Delete note"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── 2. PLAYLISTS CATEGORY (FOLDABLE) ────────────────────────────── */}
      {(selectedType === 'all' || selectedType === 'playlists') && (
        <div className="mb-8">
          <button
            type="button"
            onClick={() => setShowPlaylistsCategory(!showPlaylistsCategory)}
            className="flex items-center space-x-2 w-full text-left focus:outline-none group mb-4"
          >
            {showPlaylistsCategory ? (
              <ChevronDown className="w-5 h-5 text-purple-500 dark:text-purple-400 group-hover:text-purple-600 dark:group-hover:text-purple-300" />
            ) : (
              <ChevronRight className="w-5 h-5 text-purple-500 dark:text-purple-400 group-hover:text-purple-600 dark:group-hover:text-purple-300" />
            )}
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center space-x-2">
              <BookOpen className="w-5 h-5 text-purple-500 dark:text-purple-400" />
              <span>{t('explorer.playlistsCategory', 'Playlists')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">({filteredPlaylists.length})</span>
            </h2>
          </button>
          
          {showPlaylistsCategory && (
            filteredPlaylists.length === 0 ? (
              <div className="text-center py-12 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-50/50 dark:bg-slate-900/30 space-y-2">
                <p className="text-sm text-slate-600 dark:text-slate-400">{t('explorer.noPlaylistsFound', 'No playlists matched your current search and filters.')}</p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedTag(null);
                    setSelectedType('all');
                  }}
                  className="text-xs text-purple-600 dark:text-purple-400 hover:underline font-semibold"
                >
                  {t('explorer.clearAllFilters', 'Clear all filters')}
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredPlaylists.map((pl) => (
                  <div
                    key={pl.id}
                    className="border border-slate-200 dark:border-purple-900/50 hover:border-purple-500/50 bg-white dark:bg-slate-900 rounded-xl p-4 flex flex-col justify-between space-y-3 transition-colors shadow-sm"
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-semibold text-purple-600 dark:text-purple-300">{t('explorer.playlistItem', 'Playlist')}</span>
                        <span>{pl.itemCount} {t('explorer.itemsCount', 'items')}</span>
                      </div>
                      <h3 className="font-semibold text-sm text-slate-900 dark:text-white leading-snug">{pl.name}</h3>
                      <div className="text-xs text-slate-700 dark:text-slate-300 space-y-1 mt-2">
                        {pl.items.slice(0, 5).map((item, idx) => (
                          <div key={idx} className="truncate text-slate-500 dark:text-slate-400">
                            • {item || t('explorer.unnamedItem', '(Unnamed item)')}
                          </div>
                        ))}
                        {pl.itemCount > 5 && (
                          <div className="text-slate-400 dark:text-slate-500 italic">
                            {t('explorer.andMoreItems', { count: pl.itemCount - 5, defaultValue: `...and ${pl.itemCount - 5} more` })}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* ── 3. BOOKMARKS CATEGORY (FOLDABLE) ────────────────────────────── */}
      {(selectedType === 'all' || selectedType === 'bookmarks') && (
        <div className="mb-8">
          <button
            type="button"
            onClick={() => setShowBookmarksCategory(!showBookmarksCategory)}
            className="flex items-center space-x-2 w-full text-left focus:outline-none group mb-4"
          >
            {showBookmarksCategory ? (
              <ChevronDown className="w-5 h-5 text-emerald-500 group-hover:text-emerald-400 transition-transform" />
            ) : (
              <ChevronRight className="w-5 h-5 text-emerald-500 group-hover:text-emerald-400 transition-transform" />
            )}
            <h2 className="text-lg font-bold text-slate-900 dark:text-white flex items-center space-x-2">
              <BookmarkIcon className="w-5 h-5 text-emerald-500" />
              <span>{t('explorer.bookmarksCategory', 'Bookmarks')}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 font-normal">({bookmarks.length})</span>
            </h2>
          </button>

          {showBookmarksCategory && (
            groupedBookmarks.length === 0 ? (
              <div className="text-center py-12 border border-slate-200 dark:border-slate-800 rounded-xl bg-slate-100/50 dark:bg-slate-900/30 space-y-2">
                <BookmarkIcon className="w-8 h-8 text-slate-400 dark:text-slate-600 mx-auto mb-2" />
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {bookmarks.length === 0 ? t('explorer.noBookmarks', 'No bookmarks found in this library.') : t('explorer.noBookmarksMatched', 'No bookmarks matched your current search.')}
                </p>
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="text-xs text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    {t('explorer.clearSearch', 'Clear search query')}
                  </button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {groupedBookmarks.map((group, gIdx) => (
                  <div
                    key={gIdx}
                    className="border border-slate-200 dark:border-slate-800 hover:border-emerald-500/40 dark:hover:border-emerald-500/40 bg-white dark:bg-slate-900 rounded-xl p-4 flex flex-col justify-between space-y-3 transition-all shadow-sm"
                  >
                    <div className="space-y-3">
                      {/* Book/Publication Tile Header */}
                      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800/80 pb-2.5">
                        <div className="flex items-center space-x-2 min-w-0">
                          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0">
                            {group.isBible ? <BookOpen className="w-4 h-4" /> : <BookmarkIcon className="w-4 h-4" />}
                          </div>
                          <div className="truncate">
                            <h3 className="font-bold text-sm text-slate-900 dark:text-white truncate">
                              {group.title}
                            </h3>
                            <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase tracking-wider font-semibold">
                              {group.isBible ? t('explorer.scriptureBook', 'Scripture Book') : t('explorer.publication', 'Publication')}
                            </span>
                          </div>
                        </div>
                        <span className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 dark:bg-emerald-500/15 px-2 py-0.5 rounded-full flex-shrink-0">
                          {group.items.length} {group.items.length === 1 ? t('explorer.bookmarkSingle', 'bookmark') : t('explorer.bookmarkPlural', 'bookmarks')}
                        </span>
                      </div>

                      {/* Bookmarks in this book */}
                      <div className="space-y-2">
                        {group.items.map((bm) => {
                          let jwLink: string | null = null;
                          if (bm.bookNumber) {
                            jwLink = getJwBibleLink(
                              bm.bookNumber,
                              bm.chapterNumber,
                              bm.blockType === 2 ? bm.blockIdentifier : null,
                              selectedLanguage
                            );
                          } else if (bm.keySymbol || bm.pubKeySymbol) {
                            jwLink = getJwPubLink(
                              bm.keySymbol || bm.pubKeySymbol || '',
                              bm.issueTagNumber || undefined,
                              bm.documentId,
                              bm.track,
                              selectedLanguage
                            );
                          }

                          return (
                            <div
                              key={bm.bookmarkId}
                              className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/80 dark:border-slate-800/80 space-y-1.5"
                            >
                              <div className="flex items-start justify-between gap-2">
                                <div className="space-y-0.5 flex-1 min-w-0">
                                  <div className="flex items-center space-x-1.5">
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                                      {t('explorer.slot', 'Slot')} {bm.slot + 1}
                                    </span>
                                    <h4 className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                                      {bm.title || (bm.bookNumber ? `${BIBLE_BOOKS[bm.bookNumber]} ch. ${bm.chapterNumber}` : t('explorer.bookmarkSingle', 'Bookmark'))}
                                    </h4>
                                  </div>
                                  {bm.snippet && (
                                    <p className="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 leading-relaxed italic">
                                      "{bm.snippet}"
                                    </p>
                                  )}
                                </div>

                                {jwLink && (
                                  <a
                                    href={jwLink}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-slate-400 hover:text-emerald-500 dark:hover:text-emerald-400 p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex-shrink-0"
                                    title="Open on JW.org"
                                  >
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  </a>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* ── EDIT NOTE MODAL ────────────────────────────────────────────── */}
      {editingNote && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-4 sm:p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100 dark:border-slate-800">
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{t('explorer.editNote')}</h3>
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">{t('explorer.noteTitleLabel', 'Title')}</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-amber-500 shadow-sm"
                />
              </div>

              <div>
                <label className="block text-slate-700 dark:text-slate-300 font-medium mb-1">{t('explorer.noteContentLabel', 'Content')}</label>
                <textarea
                  rows={6}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-800 rounded-md px-3 py-2 text-sm text-slate-900 dark:text-white focus:outline-none focus:border-amber-500 font-sans leading-relaxed shadow-sm"
                />
              </div>
            </div>

            <div className="flex items-center justify-end space-x-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setEditingNote(null)}
                className="px-3 py-1.5 rounded-md text-xs text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={saveEditedNote}
                className="px-4 py-1.5 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs transition-colors shadow-sm"
              >
                {t('explorer.saveChanges')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── LIBRARY DOCTOR DRAWER / MODAL ──────────────────────────────── */}
      {showDoctor && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-xl w-full p-4 sm:p-6 space-y-6 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center space-x-2 text-slate-900 dark:text-white font-bold">
                <Stethoscope className="w-5 h-5 text-teal-500 dark:text-teal-400" />
                <span>{t('explorer.doctorTitle')}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowDoctor(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Scan for corrupted, duplicate, or orphaned records within your SQLite database. You can safely prune
              them with 1 click without affecting legitimate study marks.
            </p>

            <div className="space-y-3">
              {doctorResults.map((check) => (
                <div
                  key={check.key}
                  className="border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 rounded-lg p-4 flex items-start justify-between gap-4"
                >
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center space-x-2">
                      <span className="font-semibold text-slate-900 dark:text-white">{check.label}</span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${
                          check.count === 0
                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        }`}
                      >
                        {check.count} found
                      </span>
                    </div>
                    <p className="text-slate-500 dark:text-slate-400">{check.description}</p>
                  </div>

                  {check.count > 0 && check.canFix && (
                    <button
                      type="button"
                      onClick={() => fixDoctorIssue(check.key, check.affectedIds)}
                      className="px-3 py-1.5 rounded bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs transition-colors flex-shrink-0 shadow-sm"
                    >
                      {t('explorer.doctorFixBtn')}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setShowDoctor(false)}
                className="px-4 py-2 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-transparent text-xs font-medium"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── TAG MANAGER MODAL ──────────────────────────────────── */}
      {showTagManager && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-4 sm:p-6 space-y-4 shadow-2xl max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center space-x-2 text-slate-900 dark:text-white font-bold">
                <Tag className="w-5 h-5 text-teal-500 dark:text-teal-400" />
                <span>{t('explorer.tagManagerTitle')}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowTagManager(false)}
                className="text-slate-400 hover:text-slate-600 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2">
              {allTags.map((tag) => (
                <div
                  key={tag.TagId}
                  className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex items-center justify-between text-xs"
                >
                  {renamingTag?.id === tag.TagId ? (
                    <div className="flex items-center space-x-2 flex-1 mr-2">
                      <input
                        type="text"
                        value={newTagName}
                        onChange={(e) => setNewTagName(e.target.value)}
                        className="bg-white dark:bg-slate-900 border border-emerald-500 rounded px-2 py-1 text-slate-900 dark:text-white text-xs flex-1 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={handleRenameTag}
                        className="px-2 py-1 bg-emerald-600 text-white rounded font-medium"
                      >
                        {t('common.save')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingTag(null)}
                        className="text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white"
                      >
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center space-x-2">
                        <span className="font-medium text-slate-800 dark:text-slate-200">#{tag.Name}</span>
                        <span className="text-slate-500">({tag.count} notes)</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={() => {
                            setRenamingTag({ id: tag.TagId, name: tag.Name });
                            setNewTagName(tag.Name);
                          }}
                          className="text-xs text-sky-600 dark:text-sky-400 hover:underline font-medium"
                        >
                          {t('explorer.renameTag')}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteTag(tag.TagId)}
                          className="text-xs text-red-500 dark:text-red-400 hover:underline font-medium"
                        >
                          {t('common.delete', 'Delete')}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800 flex justify-end">
              <button
                type="button"
                onClick={() => setShowTagManager(false)}
                className="px-4 py-2 rounded-md bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-transparent text-xs font-medium"
              >
                {t('common.close', 'Close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
