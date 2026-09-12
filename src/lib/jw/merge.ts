/**
 * Panda JL Studio — Core Multi-Database Merge Engine
 * 100% Client-Side SQLite Merge using WebAssembly (sql.js).
 * 
 * Rules:
 * - Tolerates benign foreign key violations (no PRAGMA foreign_keys = ON)
 * - MepsLanguage=0 for personal notes, NULL for study questions (InputField)
 * - Exact duplicate note resolution (text + anchor)
 * - Tag re-mapping and deduplication
 * - UserMark & BlockRange highlight merging with color remapping
 * - Recomputes SHA-256 hash and updates manifest.json
 */

import type { Database } from 'sql.js';
import type {
  IManifest,
  IMergeOptions,
  IMergeProgress,
  TagManagerMap,
  ILocation,
  INote,
  IUserMark,
  IBlockRange,
  ITag,
  ITagMap,
  IBookmark,
  IInputField,
  IMergeDetails,
} from './types.ts';
import {
  openDatabase,
  queryAll,
  queryOne,
  execute,
  tableExists,
  columnExists,
  exportDatabase,
} from './sqlite.ts';
import { createOrUpdateManifest } from './manifest.ts';
import { packageJwLibrary } from './zip.ts';
import { runHealthChecks, applyHealthFix } from './doctor.ts';

export interface IMergeResult {
  mergedBlob: Blob;
  mergedDbBytes: Uint8Array;
  manifest: IManifest;
  extraFiles?: Map<string, Uint8Array>;
  stats: {
    notesAdded: number;
    notesMerged: number;
    marksAdded: number;
    tagsAdded: number;
    bookmarksAdded: number;
    inputFieldsAdded: number;
    playlistsMerged?: number;
  };
  details: IMergeDetails;
  previewNotes: Array<{
    title: string;
    content: string;
    source: string;
  }>;
}

export async function mergeJwLibraries(
  primaryDbBytes: Uint8Array,
  primaryManifest: IManifest,
  secondaryFiles: Array<{
    name: string;
    dbBytes: Uint8Array;
    manifest: IManifest;
    extraFiles?: Map<string, Uint8Array>;
  }>,
  options: IMergeOptions = {},
  tagManager: TagManagerMap = {},
  onProgress?: (progress: IMergeProgress) => void,
  primaryExtraFiles?: Map<string, Uint8Array>
): Promise<IMergeResult> {
  const stats = {
    notesAdded: 0,
    notesMerged: 0,
    marksAdded: 0,
    tagsAdded: 0,
    bookmarksAdded: 0,
    inputFieldsAdded: 0,
    playlistsMerged: 0,
  };
  const details: IMergeDetails = {
    addedNotes: [],
    unifiedDuplicates: [],
    combinedHighlights: [],
    consolidatedTags: [],
    addedBookmarks: [],
    mergedPlaylists: [],
  };
  const previewNotes: Array<{ title: string; content: string; source: string }> = [];

  onProgress?.({
    current: 5,
    total: 100,
    stage: 'Opening primary database...',
    details: primaryManifest.name || 'Primary Library',
  });

  const mainDb = await openDatabase(primaryDbBytes);

  // Disable aggressive foreign key enforcement to safely handle JW Library's benign FK anomalies
  try {
    mainDb.run('PRAGMA foreign_keys = OFF;');
  } catch (_) {}

  // Helper for generating UUIDs
  const generateGuid = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'jlib-' + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  };

  const totalSecondaries = secondaryFiles.length;
  const secShare = 65 / (totalSecondaries || 1);

  for (let sIdx = 0; sIdx < totalSecondaries; sIdx++) {
    const sec = secondaryFiles[sIdx];
    const secName = sec.name || `Secondary #${sIdx + 1}`;
    const secBase = 5 + sIdx * secShare;

    onProgress?.({
      current: Math.round(secBase + secShare * 0.05),
      total: 100,
      stage: `Mapping verse locations (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });

    const secDb = await openDatabase(sec.dbBytes);

    // ── 1. Map & Merge Locations ───────────────────────────────────────────
    const locationMap = new Map<number, number>(); // secLocId -> mainLocId

    if (tableExists(secDb, 'Location') && tableExists(mainDb, 'Location')) {
      const hasSpecialty = columnExists(mainDb, 'Location', 'Specialty');
      const hasEdition = columnExists(mainDb, 'Location', 'Edition');
      const specClause = hasSpecialty ? 'AND IFNULL(Specialty, \'\') = :spec' : '';

      const secLocations = queryAll<ILocation>(secDb, 'SELECT * FROM Location');

      for (const loc of secLocations) {
        // Find matching location in mainDb based on UNIQUE constraint and type attributes
        const findSql = `
          SELECT LocationId FROM Location 
          WHERE IFNULL(BookNumber, -1) = :book
            AND IFNULL(ChapterNumber, -1) = :chap
            AND IFNULL(KeySymbol, '') = :key
            AND IFNULL(MepsLanguage, -1) = :meps
            AND IFNULL(Type, 0) = :type
            AND IFNULL(DocumentId, -1) = :doc
            AND IFNULL(Track, -1) = :track
            AND IFNULL(IssueTagNumber, 0) = :issue
            ${specClause}
          LIMIT 1
        `;

        const match = queryOne<{ LocationId: number }>(mainDb, findSql, {
          ':book': loc.BookNumber ?? -1,
          ':chap': loc.ChapterNumber ?? -1,
          ':key': loc.KeySymbol ?? '',
          ':meps': loc.MepsLanguage ?? -1,
          ':type': loc.Type ?? 0,
          ':doc': loc.DocumentId ?? -1,
          ':track': loc.Track ?? -1,
          ':issue': loc.IssueTagNumber ?? 0,
          ...(hasSpecialty ? { ':spec': loc.Specialty ?? '' } : {}),
        });

        if (match) {
          locationMap.set(loc.LocationId, match.LocationId);
        } else {
          // Insert new location into mainDb
          const cols = ['BookNumber', 'ChapterNumber', 'DocumentId', 'Track', 'IssueTagNumber', 'KeySymbol', 'MepsLanguage', 'Type', 'Title'];
          const valPlaceholders = [':b', ':c', ':d', ':tr', ':i', ':k', ':m', ':ty', ':t'];
          const params: Record<string, any> = {
            ':b': loc.BookNumber ?? null,
            ':c': loc.ChapterNumber ?? null,
            ':d': loc.DocumentId ?? null,
            ':tr': loc.Track ?? null,
            ':i': loc.IssueTagNumber ?? 0,
            ':k': loc.KeySymbol ?? null,
            ':m': loc.MepsLanguage ?? null,
            ':ty': loc.Type ?? 0,
            ':t': loc.Title ?? null,
          };

          if (hasSpecialty) {
            cols.push('Specialty');
            valPlaceholders.push(':spec');
            params[':spec'] = loc.Specialty ?? null;
          }
          if (hasEdition) {
            cols.push('Edition');
            valPlaceholders.push(':ed');
            params[':ed'] = loc.Edition ?? null;
          }

          execute(
            mainDb,
            `INSERT INTO Location (${cols.join(', ')}) VALUES (${valPlaceholders.join(', ')})`,
            params
          );
          const newIdRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
          if (newIdRow) {
            locationMap.set(loc.LocationId, newIdRow.id);
          }
        }
      }
    }

    // ── 2. Map & Merge Tags ────────────────────────────────────────────────
    onProgress?.({
      current: Math.round(secBase + secShare * 0.2),
      total: 100,
      stage: `Consolidating personal study tags (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });
    const tagMap = new Map<number, number>(); // secTagId -> mainTagId

    if (tableExists(secDb, 'Tag') && tableExists(mainDb, 'Tag')) {
      // Ensure mainDb has at most one system favorite tag (Type = 0)
      const existingFavTags = queryAll<{ TagId: number }>(
        mainDb,
        'SELECT TagId FROM Tag WHERE Type = 0 ORDER BY TagId ASC'
      );
      if (existingFavTags.length > 1) {
        const canonicalFavId = existingFavTags[0].TagId;
        const duplicateFavIds = existingFavTags.slice(1).map((t) => t.TagId);
        for (const dupId of duplicateFavIds) {
          if (tableExists(mainDb, 'TagMap')) {
            const dupTagMaps = queryAll<ITagMap>(
              mainDb,
              'SELECT * FROM TagMap WHERE TagId = :dupId',
              { ':dupId': dupId }
            );
            for (const tm of dupTagMaps) {
              const alreadyExists = queryOne(
                mainDb,
                'SELECT 1 FROM TagMap WHERE TagId = :canon AND LocationId = :loc LIMIT 1',
                { ':canon': canonicalFavId, ':loc': tm.LocationId }
              );
              if (!alreadyExists && tm.LocationId) {
                const nextPosRow = queryOne<{ nextPos: number }>(
                  mainDb,
                  'SELECT COALESCE(MAX(Position), -1) + 1 AS nextPos FROM TagMap WHERE TagId = :tid',
                  { ':tid': canonicalFavId }
                );
                execute(
                  mainDb,
                  'UPDATE TagMap SET TagId = :canon, Position = :pos WHERE TagMapId = :tmid',
                  { ':canon': canonicalFavId, ':pos': nextPosRow?.nextPos ?? 0, ':tmid': tm.TagMapId }
                );
              } else {
                execute(mainDb, 'DELETE FROM TagMap WHERE TagMapId = :tmid', { ':tmid': tm.TagMapId });
              }
            }
          }
          execute(mainDb, 'DELETE FROM Tag WHERE TagId = :dupId', { ':dupId': dupId });
        }
      }

      const secTags = queryAll<ITag>(secDb, 'SELECT * FROM Tag');

      for (const tag of secTags) {
        let finalTagName = tag.Name;
        // Only apply user tagManager rules to personal study tags (Type = 1), never playlists (Type = 2) or system tags (Type = 0)
        if (tag.Type === 1) {
          const rule = tagManager[tag.Name];
          if (rule) {
            if (rule.action === 'merge' && rule.targetName) {
              finalTagName = rule.targetName;
            } else if (rule.action === 'rename' && rule.customName?.trim()) {
              finalTagName = rule.customName.trim();
            }
          }
        }

        const match = tag.Type === 0
          ? queryOne<{ TagId: number }>(mainDb, 'SELECT TagId FROM Tag WHERE Type = 0 LIMIT 1')
          : queryOne<{ TagId: number }>(
              mainDb,
              'SELECT TagId FROM Tag WHERE Name = :name COLLATE NOCASE AND Type = :type LIMIT 1',
              { ':name': finalTagName, ':type': tag.Type ?? 1 }
            );

        if (match) {
          tagMap.set(tag.TagId, match.TagId);
          details.consolidatedTags.push({ name: finalTagName, action: 'merged' });
        } else {
          execute(
            mainDb,
            'INSERT INTO Tag (Type, Name) VALUES (:type, :name)',
            { ':type': tag.Type ?? 1, ':name': finalTagName }
          );
          const newIdRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
          if (newIdRow) {
            tagMap.set(tag.TagId, newIdRow.id);
            stats.tagsAdded++;
            details.consolidatedTags.push({ name: finalTagName, action: 'created' });
          }
        }
      }
    }

    // ── 3. Map & Merge UserMark & BlockRange (Highlights) ──────────────────
    onProgress?.({
      current: Math.round(secBase + secShare * 0.35),
      total: 100,
      stage: `Combining color highlights & markers (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });
    const userMarkMap = new Map<number, number>(); // secUserMarkId -> mainUserMarkId

    if (
      tableExists(secDb, 'UserMark') &&
      tableExists(mainDb, 'UserMark') &&
      tableExists(secDb, 'BlockRange') &&
      tableExists(mainDb, 'BlockRange')
    ) {
      const secMarks = queryAll<IUserMark>(secDb, 'SELECT * FROM UserMark');

      for (const mark of secMarks) {
        const mappedLocId = mark.LocationId ? locationMap.get(mark.LocationId) : null;
        if (!mappedLocId) continue;

        // Apply color rule if configured
        let finalColorIndex = mark.ColorIndex;
        if (options.colorRules && options.colorRules[mark.ColorIndex] !== undefined) {
          finalColorIndex = options.colorRules[mark.ColorIndex];
        }

        // Check associated block ranges
        const secRanges = queryAll<IBlockRange>(
          secDb,
          'SELECT * FROM BlockRange WHERE UserMarkId = :uid',
          { ':uid': mark.UserMarkId }
        );

        // Check if an identical highlight exists in mainDb
        let existingMainMarkId: number | null = null;
        if (secRanges.length > 0) {
          const firstRange = secRanges[0];
          const matchMark = queryOne<{ UserMarkId: number }>(
            mainDb,
            `SELECT um.UserMarkId FROM UserMark um
             JOIN BlockRange br ON um.UserMarkId = br.UserMarkId
             WHERE um.LocationId = :loc 
               AND br.Identifier = :ident 
               AND br.StartToken = :st 
               AND br.EndToken = :et
             LIMIT 1`,
            {
              ':loc': mappedLocId,
              ':ident': firstRange.Identifier,
              ':st': firstRange.StartToken,
              ':et': firstRange.EndToken,
            }
          );
          if (matchMark) {
            existingMainMarkId = matchMark.UserMarkId;
          }
        }

        if (existingMainMarkId) {
          userMarkMap.set(mark.UserMarkId, existingMainMarkId);
        } else {
          // Check GUID collision
          const guidExists = queryOne<{ c: number }>(
            mainDb,
            'SELECT COUNT(*) AS c FROM UserMark WHERE UserMarkGuid = :guid',
            { ':guid': mark.UserMarkGuid }
          );
          const finalGuid =
            guidExists && guidExists.c > 0 ? generateGuid() : mark.UserMarkGuid;

          const hasStyleIndex = columnExists(mainDb, 'UserMark', 'StyleIndex');
          const hasVersion = columnExists(mainDb, 'UserMark', 'Version');
          const umCols = ['ColorIndex', 'LocationId', 'UserMarkGuid'];
          const umVals = [':col', ':loc', ':guid'];
          const umParams: Record<string, any> = {
            ':col': finalColorIndex,
            ':loc': mappedLocId,
            ':guid': finalGuid,
          };
          if (hasStyleIndex) {
            umCols.push('StyleIndex');
            umVals.push(':sty');
            umParams[':sty'] = mark.StyleIndex ?? 0;
          }
          if (hasVersion) {
            umCols.push('Version');
            umVals.push(':ver');
            umParams[':ver'] = mark.Version ?? 1;
          }

          execute(
            mainDb,
            `INSERT INTO UserMark (${umCols.join(', ')}) VALUES (${umVals.join(', ')})`,
            umParams
          );
          const newMarkRow = queryOne<{ id: number }>(
            mainDb,
            'SELECT last_insert_rowid() AS id'
          );
          if (newMarkRow) {
            const newMarkId = newMarkRow.id;
            userMarkMap.set(mark.UserMarkId, newMarkId);
            stats.marksAdded++;

            const markLoc = mark.LocationId
              ? queryOne<{ Title: string }>(secDb, 'SELECT Title FROM Location WHERE LocationId = :id', { ':id': mark.LocationId })
              : null;
            details.combinedHighlights.push({
              colorIndex: finalColorIndex,
              locationTitle: markLoc?.Title || 'Bible / Publication',
            });

            // Insert associated block ranges
            for (const br of secRanges) {
              execute(
                mainDb,
                `INSERT INTO BlockRange (BlockType, Identifier, StartToken, EndToken, UserMarkId)
                 VALUES (:bt, :id, :st, :et, :uid)`,
                {
                  ':bt': br.BlockType,
                  ':id': br.Identifier,
                  ':st': br.StartToken,
                  ':et': br.EndToken,
                  ':uid': newMarkId,
                }
              );
            }
          }
        }
      }
    }

    // ── 4. Map & Merge Notes ───────────────────────────────────────────────
    onProgress?.({
      current: Math.round(secBase + secShare * 0.55),
      total: 100,
      stage: `Merging study notes & resolving conflicts (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });
    const noteMap = new Map<number, number>(); // secNoteId -> mainNoteId
    const notesToTagWithSecondary: number[] = [];

    if (tableExists(secDb, 'Note') && tableExists(mainDb, 'Note')) {
      const secNotes = queryAll<INote>(secDb, 'SELECT * FROM Note');

      for (const note of secNotes) {
        if (options.excludedNoteGuids?.includes(note.Guid)) {
          continue;
        }

        const noteOverride = options.noteOverrides?.[note.Guid];
        const effectiveTitle = noteOverride?.title !== undefined ? noteOverride.title : note.Title;
        const effectiveContent = noteOverride?.content !== undefined ? noteOverride.content : note.Content;

        const mappedLocId = note.LocationId ? locationMap.get(note.LocationId) ?? null : null;
        const mappedMarkId = note.UserMarkId ? userMarkMap.get(note.UserMarkId) ?? null : null;

        const locRow = note.LocationId
          ? queryOne<{ Title?: string; BookNumber?: number; ChapterNumber?: number }>(
              secDb,
              'SELECT Title, BookNumber, ChapterNumber FROM Location WHERE LocationId = :id',
              { ':id': note.LocationId }
            )
          : null;
        const locTitle =
          locRow?.Title ||
          (locRow?.BookNumber ? `Book ${locRow.BookNumber}${locRow.ChapterNumber ? `:${locRow.ChapterNumber}` : ''}` : effectiveTitle || 'Personal Study');

        const hasBt = columnExists(mainDb, 'Note', 'BlockType');
        const hasBi = columnExists(mainDb, 'Note', 'BlockIdentifier');

        const btClause = hasBt ? 'AND IFNULL(BlockType, -1) = :bt' : '';
        const biClause = hasBi ? 'AND IFNULL(BlockIdentifier, -1) = :bi' : '';

        // Duplicate Check: Same trimmed Title, Content, and Anchor
        const dupMatch = queryOne<{ NoteId: number }>(
          mainDb,
          `SELECT NoteId FROM Note 
           WHERE TRIM(IFNULL(Title, '')) = :t 
             AND TRIM(IFNULL(Content, '')) = :c 
             AND IFNULL(LocationId, -1) = :l
             ${btClause}
             ${biClause}
           LIMIT 1`,
          {
            ':t': (effectiveTitle || '').trim(),
            ':c': (effectiveContent || '').trim(),
            ':l': mappedLocId ?? -1,
            ...(hasBt ? { ':bt': note.BlockType ?? -1 } : {}),
            ...(hasBi ? { ':bi': note.BlockIdentifier ?? -1 } : {}),
          }
        );

        if (dupMatch) {
          noteMap.set(note.NoteId, dupMatch.NoteId);
          stats.notesMerged++;
          details.unifiedDuplicates.push({
            guid: note.Guid,
            noteId: dupMatch.NoteId,
            title: effectiveTitle || '(Untitled Note)',
            content: effectiveContent || '',
            locationTitle: locTitle,
            source: secName,
            action: 'unified',
          });
        } else {
          // Respect explicit conflict resolution if configured
          const conflictChoice = options.conflictResolutions?.[note.Guid];
          if (conflictChoice === 'a') {
            // Discard secondary note, keep primary
            continue;
          }
          if (conflictChoice === 'b') {
            // Overwrite primary with secondary
            const existingInMain = queryOne<{ NoteId: number }>(mainDb, 'SELECT NoteId FROM Note WHERE Guid = :guid', { ':guid': note.Guid });
            if (existingInMain) {
              execute(mainDb, 'UPDATE Note SET Content = :c, Title = :t, LastModified = :lm WHERE NoteId = :id', {
                ':c': effectiveContent ?? null,
                ':t': effectiveTitle ?? null,
                ':lm': note.LastModified || new Date().toISOString(),
                ':id': existingInMain.NoteId,
              });
              noteMap.set(note.NoteId, existingInMain.NoteId);
              notesToTagWithSecondary.push(existingInMain.NoteId);
              stats.notesMerged++;
              details.unifiedDuplicates.push({
                guid: note.Guid,
                noteId: existingInMain.NoteId,
                title: effectiveTitle || '(Untitled Note)',
                content: effectiveContent || '',
                locationTitle: locTitle,
                source: secName,
                action: 'unified',
              });
              continue;
            }
          }

          // Check GUID collision
          const guidExists = queryOne<{ c: number }>(
            mainDb,
            'SELECT COUNT(*) AS c FROM Note WHERE Guid = :guid',
            { ':guid': note.Guid }
          );
          const finalGuid =
            guidExists && guidExists.c > 0 ? generateGuid() : note.Guid;

          const hasNoteBt = columnExists(mainDb, 'Note', 'BlockType');
          const hasNoteBi = columnExists(mainDb, 'Note', 'BlockIdentifier');

          const noteCols = ['Guid', 'UserMarkId', 'LocationId', 'Title', 'Content', 'LastModified', 'Created'];
          const noteVals = [':g', ':um', ':loc', ':t', ':c', ':lm', ':cr'];
          const noteParams: Record<string, any> = {
            ':g': finalGuid,
            ':um': mappedMarkId,
            ':loc': mappedLocId,
            ':t': effectiveTitle ?? null,
            ':c': effectiveContent ?? null,
            ':lm': note.LastModified || new Date().toISOString(),
            ':cr': note.Created || new Date().toISOString(),
          };

          if (hasNoteBt) {
            noteCols.push('BlockType');
            noteVals.push(':bt');
            noteParams[':bt'] = note.BlockType ?? 0;
          }
          if (hasNoteBi) {
            noteCols.push('BlockIdentifier');
            noteVals.push(':bi');
            noteParams[':bi'] = note.BlockType === 0 ? null : (note.BlockIdentifier ?? null);
          }

          execute(
            mainDb,
            `INSERT INTO Note (${noteCols.join(', ')}) VALUES (${noteVals.join(', ')})`,
            noteParams
          );

          const newNoteRow = queryOne<{ id: number }>(
            mainDb,
            'SELECT last_insert_rowid() AS id'
          );
          if (newNoteRow) {
            noteMap.set(note.NoteId, newNoteRow.id);
            notesToTagWithSecondary.push(newNoteRow.id);
            stats.notesAdded++;

            details.addedNotes.push({
              guid: note.Guid,
              noteId: newNoteRow.id,
              title: effectiveTitle || '(Untitled Note)',
              content: effectiveContent || '',
              locationTitle: locTitle,
              source: secName,
              action: 'added',
            });

            if (previewNotes.length < 5) {
              previewNotes.push({
                title: effectiveTitle || '(Untitled Note)',
                content: (effectiveContent || '').slice(0, 100),
                source: secName,
              });
            }
          }
        }
      }
    }

    // TagMap merge moved after playlists

    // ── 6. Merge Bookmarks ─────────────────────────────────────────────────
    onProgress?.({
      current: Math.round(secBase + secShare * 0.78),
      total: 100,
      stage: `Synchronizing bookmarks (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });
    if (tableExists(secDb, 'Bookmark') && tableExists(mainDb, 'Bookmark')) {
      const secBookmarks = queryAll<IBookmark>(secDb, 'SELECT * FROM Bookmark');

      for (const bm of secBookmarks) {
        const mappedLocId = locationMap.get(bm.LocationId);
        const mappedPubLocId = bm.PublicationLocationId
          ? locationMap.get(bm.PublicationLocationId) ?? mappedLocId
          : mappedLocId;

        if (!mappedLocId || !mappedPubLocId) continue;

        const blockType = bm.BlockType ?? 0;
        const blockId = blockType === 0 ? null : (bm.BlockIdentifier ?? null);

        const hasBmBt = columnExists(mainDb, 'Bookmark', 'BlockType');
        const hasBmBi = columnExists(mainDb, 'Bookmark', 'BlockIdentifier');
        const hasBmPub = columnExists(mainDb, 'Bookmark', 'PublicationLocationId');

        // Check if bookmark already exists for the same content in this publication
        const btClause = hasBmBt ? 'AND IFNULL(BlockType, 0) = :bt' : '';
        const biClause = hasBmBi ? 'AND IFNULL(BlockIdentifier, -1) = :bi' : '';
        const pubClause = hasBmPub ? 'AND PublicationLocationId = :plid' : '';

        const sameContentMatch = queryOne<{ BookmarkId: number }>(
          mainDb,
          `SELECT BookmarkId FROM Bookmark 
           WHERE LocationId = :lid 
             ${pubClause}
             ${btClause}
             ${biClause}
           LIMIT 1`,
          {
            ':lid': mappedLocId,
            ...(hasBmPub ? { ':plid': mappedPubLocId } : {}),
            ...(hasBmBt ? { ':bt': blockType } : {}),
            ...(hasBmBi ? { ':bi': blockId ?? -1 } : {}),
          }
        );
        if (sameContentMatch) continue;

        // Resolve slot collision safely within valid range 0..9
        let targetSlot = bm.Slot;
        const slotTaken =
          targetSlot >= 10 ||
          (queryOne<{ c: number }>(
            mainDb,
            `SELECT COUNT(*) AS c FROM Bookmark WHERE ${hasBmPub ? 'PublicationLocationId = :plid' : 'LocationId = :lid'} AND Slot = :slot`,
            {
              ...(hasBmPub ? { ':plid': mappedPubLocId } : { ':lid': mappedLocId }),
              ':slot': targetSlot,
            }
          )?.c ?? 0) > 0;

        if (slotTaken) {
          const occupiedSlots = new Set(
            queryAll<{ Slot: number }>(
              mainDb,
              `SELECT Slot FROM Bookmark WHERE ${hasBmPub ? 'PublicationLocationId = :plid' : 'LocationId = :lid'}`,
              hasBmPub ? { ':plid': mappedPubLocId } : { ':lid': mappedLocId }
            ).map((r) => r.Slot)
          );

          let firstFreeSlot = -1;
          for (let s = 0; s < 10; s++) {
            if (!occupiedSlots.has(s)) {
              firstFreeSlot = s;
              break;
            }
          }
          if (firstFreeSlot === -1) {
            // All 10 slots (0-9) are occupied for this publication;
            // skip to prevent creating slot >= 10 which breaks JW Library restore
            continue;
          }
          targetSlot = firstFreeSlot;
        }

        const bmCols = ['LocationId', 'Slot', 'Title', 'Snippet'];
        const bmVals = [':lid', ':slot', ':title', ':snip'];
        const bmParams: Record<string, any> = {
          ':lid': mappedLocId,
          ':slot': targetSlot,
          ':title': bm.Title ?? '',
          ':snip': bm.Snippet ?? null,
        };

        if (hasBmPub) {
          bmCols.push('PublicationLocationId');
          bmVals.push(':plid');
          bmParams[':plid'] = mappedPubLocId;
        }
        if (hasBmBt) {
          bmCols.push('BlockType');
          bmVals.push(':bt');
          bmParams[':bt'] = bm.BlockType ?? 0;
        }
        if (hasBmBi) {
          bmCols.push('BlockIdentifier');
          bmVals.push(':bi');
          bmParams[':bi'] = bm.BlockType === 0 ? null : (bm.BlockIdentifier ?? null);
        }

        execute(
          mainDb,
          `INSERT INTO Bookmark (${bmCols.join(', ')}) VALUES (${bmVals.join(', ')})`,
          bmParams
        );
        stats.bookmarksAdded++;
        const bmLoc = mappedLocId
          ? queryOne<{ Title: string }>(mainDb, 'SELECT Title FROM Location WHERE LocationId = :id', { ':id': mappedLocId })
          : null;
        details.addedBookmarks.push({
          title: bm.Title || bm.Snippet || `Slot ${targetSlot}`,
          slot: targetSlot,
          locationTitle: bmLoc?.Title || '',
        });
      }
    }

    // ── 7. Merge InputFields (Study Answers) ───────────────────────────────
    onProgress?.({
      current: Math.round(secBase + secShare * 0.9),
      total: 100,
      stage: `Merging study answers & playlists (${sIdx + 1}/${totalSecondaries})...`,
      details: secName,
    });
    if (tableExists(secDb, 'InputField') && tableExists(mainDb, 'InputField')) {
      const secInputs = queryAll<IInputField>(secDb, 'SELECT * FROM InputField');

      for (const inp of secInputs) {
        const mappedLocId = locationMap.get(inp.LocationId);
        if (!mappedLocId) continue;

        const existing = queryOne<IInputField>(
          mainDb,
          'SELECT Value FROM InputField WHERE LocationId = :lid AND TextTag = :tag LIMIT 1',
          { ':lid': mappedLocId, ':tag': inp.TextTag }
        );

        if (!existing) {
          execute(
            mainDb,
            'INSERT INTO InputField (LocationId, TextTag, Value) VALUES (:lid, :tag, :val)',
            { ':lid': mappedLocId, ':tag': inp.TextTag, ':val': inp.Value }
          );
          stats.inputFieldsAdded++;
        }
      }
    }

    // ── 8. Merge Playlists & Independent Media ─────────────────────────────
    // Seed PlaylistItemAccuracy if needed to satisfy FK references
    if (tableExists(mainDb, 'PlaylistItemAccuracy')) {
      execute(
        mainDb,
        `INSERT OR IGNORE INTO PlaylistItemAccuracy (PlaylistItemAccuracyId, Description) VALUES (1, 'Accurate'), (2, 'NeedsUserVerification')`
      );
    }

    const mediaMap = new Map<number, number>(); // secMediaId -> mainMediaId
    if (tableExists(secDb, 'IndependentMedia') && tableExists(mainDb, 'IndependentMedia')) {
      const secMedias = queryAll<any>(secDb, 'SELECT * FROM IndependentMedia');
      for (const media of secMedias) {
        const dup = queryOne<{ IndependentMediaId: number }>(
          mainDb,
          'SELECT IndependentMediaId FROM IndependentMedia WHERE FilePath = :f OR Hash = :h LIMIT 1',
          { ':h': media.Hash, ':f': media.FilePath }
        );
        if (dup) {
          mediaMap.set(media.IndependentMediaId, dup.IndependentMediaId);
        } else {
          execute(
            mainDb,
            'INSERT OR IGNORE INTO IndependentMedia (OriginalFilename, FilePath, MimeType, Hash) VALUES (:o, :f, :m, :h)',
            { ':o': media.OriginalFilename, ':f': media.FilePath, ':m': media.MimeType, ':h': media.Hash }
          );
          const newIdRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
          if (newIdRow) mediaMap.set(media.IndependentMediaId, newIdRow.id);
        }
      }
    }

    const playlistMap = new Map<number, number>(); // secPlaylistItemId -> mainPlaylistItemId
    if (tableExists(secDb, 'PlaylistItem') && tableExists(mainDb, 'PlaylistItem')) {
      const secPlaylists = queryAll<any>(secDb, 'SELECT * FROM PlaylistItem');
      for (const pl of secPlaylists) {
        // Validate thumbnail path exists in IndependentMedia to satisfy FK constraint
        const thumbValid = pl.ThumbnailFilePath
          ? queryOne(mainDb, 'SELECT 1 FROM IndependentMedia WHERE FilePath = :f LIMIT 1', { ':f': pl.ThumbnailFilePath })
          : null;
        const finalThumb = thumbValid ? pl.ThumbnailFilePath : null;

        // Check if identical playlist item already exists in mainDb
        const existingPl = queryOne<{ PlaylistItemId: number }>(
          mainDb,
          `SELECT PlaylistItemId FROM PlaylistItem 
           WHERE IFNULL(Label, '') = :l 
             AND IFNULL(StartTrimOffsetTicks, -1) = :s 
             AND IFNULL(EndTrimOffsetTicks, -1) = :e 
             AND Accuracy = :a 
             AND EndAction = :ea 
             AND IFNULL(ThumbnailFilePath, '') = :t 
           LIMIT 1`,
          {
            ':l': pl.Label ?? '',
            ':s': pl.StartTrimOffsetTicks ?? -1,
            ':e': pl.EndTrimOffsetTicks ?? -1,
            ':a': pl.Accuracy ?? 1,
            ':ea': pl.EndAction ?? 0,
            ':t': finalThumb ?? '',
          }
        );

        if (existingPl) {
          playlistMap.set(pl.PlaylistItemId, existingPl.PlaylistItemId);
          continue;
        }

        execute(
          mainDb,
          'INSERT INTO PlaylistItem (Label, StartTrimOffsetTicks, EndTrimOffsetTicks, Accuracy, EndAction, ThumbnailFilePath) VALUES (:l, :s, :e, :a, :ea, :t)',
          {
            ':l': pl.Label,
            ':s': pl.StartTrimOffsetTicks ?? null,
            ':e': pl.EndTrimOffsetTicks ?? null,
            ':a': pl.Accuracy ?? 1,
            ':ea': pl.EndAction ?? 0,
            ':t': finalThumb,
          }
        );
        const newIdRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
        if (newIdRow) {
          playlistMap.set(pl.PlaylistItemId, newIdRow.id);
          stats.playlistsMerged++;
          details.mergedPlaylists.push({
            name: pl.Label || 'Playlist item',
          });

          // PlaylistItemIndependentMediaMap
          if (tableExists(secDb, 'PlaylistItemIndependentMediaMap') && tableExists(mainDb, 'PlaylistItemIndependentMediaMap')) {
            const secMediaMaps = queryAll<any>(secDb, 'SELECT * FROM PlaylistItemIndependentMediaMap WHERE PlaylistItemId = :pid', { ':pid': pl.PlaylistItemId });
            for (const mm of secMediaMaps) {
              const mappedMediaId = mediaMap.get(mm.IndependentMediaId);
              if (mappedMediaId) {
                execute(
                  mainDb,
                  'INSERT OR IGNORE INTO PlaylistItemIndependentMediaMap (PlaylistItemId, IndependentMediaId, DurationTicks) VALUES (:pid, :mid, :d)',
                  { ':pid': newIdRow.id, ':mid': mappedMediaId, ':d': mm.DurationTicks ?? 0 }
                );
              }
            }
          }

          // PlaylistItemLocationMap
          if (tableExists(secDb, 'PlaylistItemLocationMap') && tableExists(mainDb, 'PlaylistItemLocationMap')) {
            const secLocMaps = queryAll<any>(secDb, 'SELECT * FROM PlaylistItemLocationMap WHERE PlaylistItemId = :pid', { ':pid': pl.PlaylistItemId });
            for (const lm of secLocMaps) {
              const mappedLocId = locationMap.get(lm.LocationId);
              if (mappedLocId) {
                execute(
                  mainDb,
                  'INSERT OR IGNORE INTO PlaylistItemLocationMap (PlaylistItemId, LocationId, MajorMultimediaType, BaseDurationTicks) VALUES (:pid, :lid, :m, :b)',
                  { ':pid': newIdRow.id, ':lid': mappedLocId, ':m': lm.MajorMultimediaType ?? 0, ':b': lm.BaseDurationTicks ?? null }
                );
              }
            }
          }

          // PlaylistItemMarker
          const markerMap = new Map<number, number>();
          if (tableExists(secDb, 'PlaylistItemMarker') && tableExists(mainDb, 'PlaylistItemMarker')) {
            const secMarkers = queryAll<any>(secDb, 'SELECT * FROM PlaylistItemMarker WHERE PlaylistItemId = :pid', { ':pid': pl.PlaylistItemId });
            for (const mk of secMarkers) {
              execute(
                mainDb,
                'INSERT INTO PlaylistItemMarker (PlaylistItemId, Label, StartTimeTicks, DurationTicks, EndTransitionDurationTicks) VALUES (:pid, :l, :s, :d, :e)',
                {
                  ':pid': newIdRow.id,
                  ':l': mk.Label,
                  ':s': mk.StartTimeTicks ?? 0,
                  ':d': mk.DurationTicks ?? 0,
                  ':e': mk.EndTransitionDurationTicks ?? 0,
                }
              );
              const newMkRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
              if (newMkRow) markerMap.set(mk.PlaylistItemMarkerId, newMkRow.id);
            }
          }

          // PlaylistItemMarkerBibleVerseMap & PlaylistItemMarkerParagraphMap (scoped to current playlist markers)
          if (markerMap.size > 0) {
            if (tableExists(secDb, 'PlaylistItemMarkerBibleVerseMap') && tableExists(mainDb, 'PlaylistItemMarkerBibleVerseMap')) {
              for (const [secMkId, mainMkId] of markerMap.entries()) {
                const secVerseMaps = queryAll<any>(
                  secDb,
                  'SELECT * FROM PlaylistItemMarkerBibleVerseMap WHERE PlaylistItemMarkerId = :mid',
                  { ':mid': secMkId }
                );
                for (const vm of secVerseMaps) {
                  execute(
                    mainDb,
                    'INSERT OR IGNORE INTO PlaylistItemMarkerBibleVerseMap (PlaylistItemMarkerId, VerseId) VALUES (:mid, :vid)',
                    { ':mid': mainMkId, ':vid': vm.VerseId }
                  );
                }
              }
            }

            if (tableExists(secDb, 'PlaylistItemMarkerParagraphMap') && tableExists(mainDb, 'PlaylistItemMarkerParagraphMap')) {
              for (const [secMkId, mainMkId] of markerMap.entries()) {
                const secParaMaps = queryAll<any>(
                  secDb,
                  'SELECT * FROM PlaylistItemMarkerParagraphMap WHERE PlaylistItemMarkerId = :mid',
                  { ':mid': secMkId }
                );
                for (const pm of secParaMaps) {
                  execute(
                    mainDb,
                    'INSERT OR IGNORE INTO PlaylistItemMarkerParagraphMap (PlaylistItemMarkerId, MepsDocumentId, ParagraphIndex, MarkerIndexWithinParagraph) VALUES (:mid, :meps, :pi, :mi)',
                    { ':mid': mainMkId, ':meps': pm.MepsDocumentId, ':pi': pm.ParagraphIndex, ':mi': pm.MarkerIndexWithinParagraph }
                  );
                }
              }
            }
          }
        }
      }
    }

    // ── 9. Merge TagMap ────────────────────────────────────────────────────
    if (tableExists(secDb, 'TagMap') && tableExists(mainDb, 'TagMap')) {
      const secTagMaps = queryAll<ITagMap>(secDb, 'SELECT * FROM TagMap ORDER BY TagId ASC, Position ASC');

      for (const tm of secTagMaps) {
        const mappedTagId = tagMap.get(tm.TagId);
        if (!mappedTagId) continue;

        const mappedNoteId = tm.NoteId ? noteMap.get(tm.NoteId) : null;
        const mappedLocId = tm.LocationId ? locationMap.get(tm.LocationId) : null;
        const mappedPlaylistId = tm.PlaylistItemId ? playlistMap.get(tm.PlaylistItemId) : null;

        // Validate exactly one target is present to fulfill TagMap CHECK constraint
        const hasNote = mappedNoteId !== null && mappedNoteId !== undefined;
        const hasLoc = mappedLocId !== null && mappedLocId !== undefined && !hasNote;
        const hasPl = !hasNote && !hasLoc && (mappedPlaylistId !== null && mappedPlaylistId !== undefined);

        if (!hasNote && !hasLoc && !hasPl) {
          continue; // Cannot insert TagMap entry with zero or ambiguous targets
        }

        const finalNoteId = hasNote ? mappedNoteId : null;
        const finalLocId = hasLoc ? mappedLocId : null;
        const finalPlaylistId = hasPl ? mappedPlaylistId : null;

        // Check if this tag mapping already exists in mainDb
        const exists = queryOne<{ c: number }>(
          mainDb,
          `SELECT COUNT(*) AS c FROM TagMap 
           WHERE TagId = :tid AND (
             (:nid IS NOT NULL AND NoteId = :nid) OR
             (:lid IS NOT NULL AND LocationId = :lid) OR
             (:plid IS NOT NULL AND PlaylistItemId = :plid)
           )`,
          {
            ':tid': mappedTagId,
            ':nid': finalNoteId,
            ':lid': finalLocId,
            ':plid': finalPlaylistId,
          }
        );

        if (!exists || exists.c === 0) {
          // Calculate next position for this tag to prevent UNIQUE(TagId, Position) violation
          const nextPosRow = queryOne<{ nextPos: number }>(
            mainDb,
            `SELECT COALESCE(MAX(Position), -1) + 1 AS nextPos FROM TagMap WHERE TagId = :tid`,
            { ':tid': mappedTagId }
          );
          const nextPos = nextPosRow ? nextPosRow.nextPos : 0;

          execute(
            mainDb,
            `INSERT OR IGNORE INTO TagMap (PlaylistItemId, LocationId, NoteId, TagId, Position)
             VALUES (:pl, :loc, :nid, :tid, :pos)`,
            {
              ':pl': finalPlaylistId,
              ':loc': finalLocId,
              ':nid': finalNoteId,
              ':tid': mappedTagId,
              ':pos': nextPos,
            }
          );
        }
      }
    }

    // ── 10. Optional: Tag Imported Secondary Notes ──────────────────────────
    const secTagName = options.secondaryNoteTag?.trim();
    if (
      secTagName &&
      notesToTagWithSecondary.length > 0 &&
      tableExists(mainDb, 'Tag') &&
      tableExists(mainDb, 'TagMap')
    ) {
      let secTagId: number | null = null;
      const existingTag = queryOne<{ TagId: number }>(
        mainDb,
        'SELECT TagId FROM Tag WHERE Name = :name COLLATE NOCASE AND Type = 1 LIMIT 1',
        { ':name': secTagName }
      );
      if (existingTag) {
        secTagId = existingTag.TagId;
      } else {
        execute(
          mainDb,
          'INSERT INTO Tag (Type, Name) VALUES (1, :name)',
          { ':name': secTagName }
        );
        const newTagRow = queryOne<{ id: number }>(mainDb, 'SELECT last_insert_rowid() AS id');
        if (newTagRow) {
          secTagId = newTagRow.id;
          stats.tagsAdded++;
          details.consolidatedTags.push({ name: secTagName, action: 'created' });
        }
      }

      if (secTagId) {
        for (const nid of notesToTagWithSecondary) {
          const alreadyTagged = queryOne<{ c: number }>(
            mainDb,
            'SELECT COUNT(*) AS c FROM TagMap WHERE TagId = :tid AND NoteId = :nid',
            { ':tid': secTagId, ':nid': nid }
          );
          if (!alreadyTagged || alreadyTagged.c === 0) {
            const nextPosRow = queryOne<{ nextPos: number }>(
              mainDb,
              'SELECT COALESCE(MAX(Position), -1) + 1 AS nextPos FROM TagMap WHERE TagId = :tid',
              { ':tid': secTagId }
            );
            const nextPos = nextPosRow ? nextPosRow.nextPos : 0;
            execute(
              mainDb,
              `INSERT OR IGNORE INTO TagMap (PlaylistItemId, LocationId, NoteId, TagId, Position) 
               VALUES (NULL, NULL, :nid, :tid, :pos)`,
              { ':nid': nid, ':tid': secTagId, ':pos': nextPos }
            );
          }
        }
      }
    }

    secDb.close();
  }

  // ── 8. Optional Doctor Health Checks & Clean ─────────────────────────────
  if (options.doctorCheck) {
    onProgress?.({
      current: 72,
      total: 100,
      stage: 'Running Library Doctor diagnostics...',
    });
    for (let pass = 0; pass < 3; pass++) {
      const healthIssues = runHealthChecks(mainDb);
      let fixedAny = false;
      for (const issue of healthIssues) {
        if (issue.count > 0 && issue.canFix) {
          applyHealthFix(mainDb, issue.key, issue.affectedIds);
          fixedAny = true;
        }
      }
      if (!fixedAny) break;
    }
  }

  // ── 9. Finalize Database & Create .jwlibrary Bundle ──────────────────────
  onProgress?.({
    current: 76,
    total: 100,
    stage: 'Exporting SQLite database...',
  });

  const mergedDbBytes = exportDatabase(mainDb);
  mainDb.close();

  onProgress?.({
    current: 80,
    total: 100,
    stage: 'Verifying integrity hash and manifest...',
  });

  const finalName = options.primaryName || `${primaryManifest.name || 'Library'} (Merged)`;
  const finalDevice = options.deviceName || 'Panda JL Studio (Web)';

  const updatedManifest = await createOrUpdateManifest(
    mergedDbBytes,
    primaryManifest,
    { name: finalName, deviceName: finalDevice }
  );

  onProgress?.({
    current: 82,
    total: 100,
    stage: 'Compressing .jwlibrary archive (0%)...',
  });

  const mergedExtraFiles = new Map<string, Uint8Array>();
  if (primaryExtraFiles) {
    for (const [k, v] of primaryExtraFiles.entries()) mergedExtraFiles.set(k, v);
  }
  for (const sec of secondaryFiles) {
    if (sec.extraFiles) {
      for (const [k, v] of sec.extraFiles.entries()) mergedExtraFiles.set(k, v);
    }
  }

  const mergedBlob = await packageJwLibrary(
    mergedDbBytes,
    updatedManifest,
    mergedExtraFiles,
    (zipPercent) => {
      const roundedZip = Math.round(zipPercent);
      const overall = Math.min(99, Math.round(82 + (zipPercent * 0.17)));
      onProgress?.({
        current: overall,
        total: 100,
        stage: `Compressing .jwlibrary archive (${roundedZip}%)...`,
      });
    }
  );

  onProgress?.({
    current: 100,
    total: 100,
    stage: 'Merge completed successfully!',
  });

  return {
    mergedBlob,
    mergedDbBytes,
    manifest: updatedManifest,
    extraFiles: mergedExtraFiles,
    stats,
    details,
    previewNotes,
  };
}

/**
 * Generates the default filename for merged backup archives.
 * Format: YYYY-MM-DD_Panda_JL.jwlibrary (e.g. 2026-09-01_Panda_JL.jwlibrary)
 */
export const getDefaultMergeFilename = (date: Date = new Date()): string => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}_Panda_JL.jwlibrary`;
};

