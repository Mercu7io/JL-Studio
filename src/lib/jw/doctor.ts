/**
 * Panda JL Studio — Archive Diagnostics & Health Checks
 * Headless diagnostics to identify and safely repair common database inconsistencies:
 * - Duplicate notes on same anchor
 * - Empty notes
 * - Orphaned block ranges
 * - Orphaned tag maps
 * - Unused tags
 * - Unused locations
 */

import type { Database } from 'sql.js';
import type { IHealthCheckResult } from './types.ts';
import { tableExists, columnExists, queryAll, queryOne, execute } from './sqlite.ts';

export function runHealthChecks(db: Database): IHealthCheckResult[] {
  const results: IHealthCheckResult[] = [];

  // 1. Duplicate Notes
  if (tableExists(db, 'Note')) {
    const bt = columnExists(db, 'Note', 'BlockType') ? 'IFNULL(BlockType,-1)' : '-1';
    const bi = columnExists(db, 'Note', 'BlockIdentifier') ? 'IFNULL(BlockIdentifier,-1)' : '-1';
    const btN = columnExists(db, 'Note', 'BlockType') ? 'IFNULL(n.BlockType,-1)' : '-1';
    const biN = columnExists(db, 'Note', 'BlockIdentifier') ? 'IFNULL(n.BlockIdentifier,-1)' : '-1';
    const keepCol = columnExists(db, 'Note', 'UserMarkId')
      ? 'COALESCE(MIN(CASE WHEN UserMarkId IS NOT NULL THEN NoteId END), MIN(NoteId))'
      : 'MIN(NoteId)';

    const sql = `
      SELECT n.NoteId AS dup, g.keepId AS keep
      FROM Note n
      JOIN (
        SELECT IFNULL(Title,'') AS t, IFNULL(Content,'') AS c, IFNULL(LocationId,-1) AS l,
               ${bt} AS bt, ${bi} AS bi, ${keepCol} AS keepId
        FROM Note
        WHERE (TRIM(IFNULL(Title,'')) <> '' OR TRIM(IFNULL(Content,'')) <> '')
        GROUP BY t, c, l, bt, bi
        HAVING COUNT(*) > 1
      ) g ON IFNULL(n.Title,'') = g.t AND IFNULL(n.Content,'') = g.c 
         AND IFNULL(n.LocationId,-1) = g.l AND ${btN} = g.bt AND ${biN} = g.bi
      WHERE n.NoteId <> g.keepId
    `;

    const dupRows = queryAll<{ dup: number; keep: number }>(db, sql);
    results.push({
      key: 'dup_notes',
      label: 'Duplicate Notes',
      count: dupRows.length,
      description: 'Identical notes on the exact same scripture or paragraph anchor.',
      canFix: true,
      affectedIds: dupRows.map((r) => r.dup),
    });
  }

  // 2. Empty Notes
  if (tableExists(db, 'Note')) {
    const sql = `
      SELECT NoteId FROM Note 
      WHERE TRIM(IFNULL(Title,'')) = '' AND TRIM(IFNULL(Content,'')) = ''
    `;
    const emptyNotes = queryAll<{ NoteId: number }>(db, sql);
    results.push({
      key: 'empty_notes',
      label: 'Empty Notes',
      count: emptyNotes.length,
      description: 'Notes containing neither title nor text.',
      canFix: true,
      affectedIds: emptyNotes.map((r) => r.NoteId),
    });
  }

  // 3. Orphaned BlockRanges
  if (tableExists(db, 'BlockRange') && tableExists(db, 'UserMark')) {
    const sql = `
      SELECT br.BlockRangeId 
      FROM BlockRange br 
      LEFT JOIN UserMark um ON br.UserMarkId = um.UserMarkId 
      WHERE um.UserMarkId IS NULL
    `;
    const orphanRanges = queryAll<{ BlockRangeId: number }>(db, sql);
    results.push({
      key: 'orph_br',
      label: 'Orphaned Highlight Ranges',
      count: orphanRanges.length,
      description: 'Highlight block positions whose parent mark was removed.',
      canFix: true,
      affectedIds: orphanRanges.map((r) => r.BlockRangeId),
    });
  }

  // 4. Orphaned TagMap Entries
  if (tableExists(db, 'TagMap') && tableExists(db, 'Note') && tableExists(db, 'Tag')) {
    const sql = `
      SELECT tm.TagMapId 
      FROM TagMap tm 
      LEFT JOIN Note n ON tm.NoteId = n.NoteId 
      LEFT JOIN Tag t ON tm.TagId = t.TagId 
      WHERE (tm.NoteId IS NOT NULL AND n.NoteId IS NULL) OR t.TagId IS NULL
    `;
    const orphanTags = queryAll<{ TagMapId: number }>(db, sql);
    results.push({
      key: 'orph_tm',
      label: 'Broken Tag Associations',
      count: orphanTags.length,
      description: 'Tags pointing to deleted notes or missing tag definitions.',
      canFix: true,
      affectedIds: orphanTags.map((r) => r.TagMapId),
    });
  }

  // 5. Unused Tags (Only user tags Type = 1; playlists Type = 2 and system tags Type = 0 must be preserved)
  if (tableExists(db, 'Tag') && tableExists(db, 'TagMap')) {
    const sql = `
      SELECT t.TagId 
      FROM Tag t 
      LEFT JOIN TagMap tm ON t.TagId = tm.TagId 
      WHERE t.Type = 1 AND tm.TagMapId IS NULL
    `;
    const unusedTags = queryAll<{ TagId: number }>(db, sql);
    results.push({
      key: 'unused_tags',
      label: 'Unused Tags',
      count: unusedTags.length,
      description: 'Study tags with zero attached notes or scriptures.',
      canFix: true,
      affectedIds: unusedTags.map((r) => r.TagId),
    });
  }

  // 6. Unused Locations
  if (tableExists(db, 'Location')) {
    const hasNotes = tableExists(db, 'Note');
    const hasMarks = tableExists(db, 'UserMark');
    const hasBookmarks = tableExists(db, 'Bookmark');
    const hasPlaylistLocs = tableExists(db, 'PlaylistItemLocationMap');
    const hasTagMap = tableExists(db, 'TagMap');
    const hasInputs = tableExists(db, 'InputField');

    const sql = `
      SELECT l.LocationId 
      FROM Location l
      ${hasNotes ? 'LEFT JOIN Note n ON l.LocationId = n.LocationId' : ''}
      ${hasMarks ? 'LEFT JOIN UserMark um ON l.LocationId = um.LocationId' : ''}
      ${hasBookmarks ? 'LEFT JOIN Bookmark bm ON l.LocationId = bm.LocationId' : ''}
      ${hasBookmarks ? 'LEFT JOIN Bookmark bmPub ON l.LocationId = bmPub.PublicationLocationId' : ''}
      ${hasPlaylistLocs ? 'LEFT JOIN PlaylistItemLocationMap plm ON l.LocationId = plm.LocationId' : ''}
      ${hasTagMap ? 'LEFT JOIN TagMap tm ON l.LocationId = tm.LocationId' : ''}
      ${hasInputs ? 'LEFT JOIN InputField inp ON l.LocationId = inp.LocationId' : ''}
      WHERE 1=1
      ${hasNotes ? 'AND n.NoteId IS NULL' : ''}
      ${hasMarks ? 'AND um.UserMarkId IS NULL' : ''}
      ${hasBookmarks ? 'AND bm.BookmarkId IS NULL AND bmPub.BookmarkId IS NULL' : ''}
      ${hasPlaylistLocs ? 'AND plm.LocationId IS NULL' : ''}
      ${hasTagMap ? 'AND tm.TagMapId IS NULL' : ''}
      ${hasInputs ? 'AND inp.LocationId IS NULL' : ''}
    `;
    const unusedLocs = queryAll<{ LocationId: number }>(db, sql);
    results.push({
      key: 'unused_loc',
      label: 'Unreferenced Locations',
      count: unusedLocs.length,
      description: 'Document references no longer tied to any study entry.',
      canFix: true,
      affectedIds: unusedLocs.map((r) => r.LocationId),
    });
  }

  // 7. Duplicate Favorite Tags & Duplicate Favorite Publications
  if (tableExists(db, 'Tag')) {
    const favTags = queryAll<{ TagId: number }>(db, 'SELECT TagId FROM Tag WHERE Type = 0 ORDER BY TagId ASC');
    let dupCount = 0;
    const affectedIds: number[] = [];

    if (favTags.length > 1) {
      dupCount += favTags.length - 1;
      affectedIds.push(...favTags.slice(1).map((t) => t.TagId));
    }

    if (tableExists(db, 'TagMap') && favTags.length > 0) {
      const canonicalId = favTags[0].TagId;
      const dupLocs = queryAll<{ LocationId: number; c: number }>(
        db,
        'SELECT LocationId, COUNT(*) as c FROM TagMap WHERE TagId = :cid AND LocationId IS NOT NULL GROUP BY LocationId HAVING COUNT(*) > 1',
        { ':cid': canonicalId }
      );
      for (const dl of dupLocs) {
        dupCount += dl.c - 1;
        affectedIds.push(dl.LocationId);
      }
    }

    if (dupCount > 0) {
      results.push({
        key: 'dup_fav_tags',
        label: 'Duplicate Favorites',
        count: dupCount,
        description: 'Multiple system favorite tags or duplicate publications pinned to home favorites.',
        canFix: true,
        affectedIds: Array.from(new Set(affectedIds)),
      });
    }
  }

  // 8. Duplicate Bookmarks & Out-of-bounds Slots (>= 10)
  if (tableExists(db, 'Bookmark')) {
    const hasPub = columnExists(db, 'Bookmark', 'PublicationLocationId');
    const pubCol = hasPub ? 'PublicationLocationId' : 'LocationId';
    const hasBt = columnExists(db, 'Bookmark', 'BlockType');
    const hasBi = columnExists(db, 'Bookmark', 'BlockIdentifier');
    const btCol = hasBt ? 'IFNULL(BlockType, 0)' : '0';
    const biCol = hasBi ? 'IFNULL(BlockIdentifier, -1)' : '-1';

    const dupBookmarksSql = `
      SELECT b.BookmarkId
      FROM Bookmark b
      JOIN (
        SELECT LocationId, ${pubCol} as pubId, ${btCol} as bt, ${biCol} as bi, MIN(BookmarkId) as keepId
        FROM Bookmark
        GROUP BY LocationId, ${pubCol}, ${btCol}, ${biCol}
        HAVING COUNT(*) > 1
      ) g ON b.LocationId = g.LocationId AND b.${pubCol} = g.pubId AND ${hasBt ? 'IFNULL(b.BlockType, 0)' : '0'} = g.bt AND ${hasBi ? 'IFNULL(b.BlockIdentifier, -1)' : '-1'} = g.bi
      WHERE b.BookmarkId <> g.keepId
    `;
    const dupBookmarks = queryAll<{ BookmarkId: number }>(db, dupBookmarksSql);
    const outOfBounds = queryAll<{ BookmarkId: number }>(db, 'SELECT BookmarkId FROM Bookmark WHERE Slot >= 10');
    const allAffected = Array.from(new Set([...dupBookmarks.map((b) => b.BookmarkId), ...outOfBounds.map((b) => b.BookmarkId)]));

    if (allAffected.length > 0) {
      results.push({
        key: 'dup_bookmarks',
        label: 'Corrupted Bookmarks',
        count: allAffected.length,
        description: 'Duplicate study bookmarks or bookmark slots outside the valid range (0-9).',
        canFix: true,
        affectedIds: allAffected,
      });
    }
  }

  return results;
}

/**
 * Safely applies repairs for a specific health check.
 */
export function applyHealthFix(
  db: Database,
  checkKey: string,
  affectedIds: number[]
): number {
  if (!affectedIds || affectedIds.length === 0) return 0;

  const idList = affectedIds.join(',');

  switch (checkKey) {
    case 'dup_notes':
    case 'empty_notes':
      if (tableExists(db, 'TagMap')) {
        execute(db, `DELETE FROM TagMap WHERE NoteId IN (${idList})`);
      }
      execute(db, `DELETE FROM Note WHERE NoteId IN (${idList})`);
      return affectedIds.length;

    case 'orph_br':
      execute(db, `DELETE FROM BlockRange WHERE BlockRangeId IN (${idList})`);
      return affectedIds.length;

    case 'orph_tm':
      execute(db, `DELETE FROM TagMap WHERE TagMapId IN (${idList})`);
      return affectedIds.length;

    case 'unused_tags':
      execute(db, `DELETE FROM Tag WHERE TagId IN (${idList})`);
      return affectedIds.length;

    case 'unused_loc':
      execute(db, `DELETE FROM Location WHERE LocationId IN (${idList})`);
      return affectedIds.length;

    case 'dup_fav_tags': {
      if (tableExists(db, 'Tag')) {
        const favTags = queryAll<{ TagId: number }>(db, 'SELECT TagId FROM Tag WHERE Type = 0 ORDER BY TagId ASC');
        if (favTags.length > 0) {
          const canonicalId = favTags[0].TagId;
          const dupIds = favTags.slice(1).map((t) => t.TagId);
          if (tableExists(db, 'TagMap')) {
            for (const dupId of dupIds) {
              const dupMaps = queryAll<{ TagMapId: number; LocationId: number }>(
                db,
                'SELECT TagMapId, LocationId FROM TagMap WHERE TagId = :did',
                { ':did': dupId }
              );
              for (const tm of dupMaps) {
                const exists = queryOne(
                  db,
                  'SELECT 1 FROM TagMap WHERE TagId = :cid AND LocationId = :lid LIMIT 1',
                  { ':cid': canonicalId, ':lid': tm.LocationId }
                );
                if (!exists && tm.LocationId) {
                  const nextPos = queryOne<{ nextPos: number }>(
                    db,
                    'SELECT COALESCE(MAX(Position), -1) + 1 AS nextPos FROM TagMap WHERE TagId = :cid',
                    { ':cid': canonicalId }
                  )?.nextPos ?? 0;
                  execute(
                    db,
                    'UPDATE TagMap SET TagId = :cid, Position = :pos WHERE TagMapId = :tmid',
                    { ':cid': canonicalId, ':pos': nextPos, ':tmid': tm.TagMapId }
                  );
                } else {
                  execute(db, 'DELETE FROM TagMap WHERE TagMapId = :tmid', { ':tmid': tm.TagMapId });
                }
              }
              execute(db, 'DELETE FROM Tag WHERE TagId = :did', { ':did': dupId });
            }

            // Deduplicate multiple entries for same LocationId under canonical tag
            const canonicalMaps = queryAll<{ TagMapId: number; LocationId: number }>(
              db,
              'SELECT TagMapId, LocationId FROM TagMap WHERE TagId = :cid ORDER BY Position ASC, TagMapId ASC',
              { ':cid': canonicalId }
            );
            const seenLocations = new Set<number>();
            let curPos = 0;
            for (const tm of canonicalMaps) {
              if (seenLocations.has(tm.LocationId)) {
                execute(db, 'DELETE FROM TagMap WHERE TagMapId = :tmid', { ':tmid': tm.TagMapId });
              } else {
                seenLocations.add(tm.LocationId);
                execute(db, 'UPDATE TagMap SET Position = :pos WHERE TagMapId = :tmid', {
                  ':pos': curPos++,
                  ':tmid': tm.TagMapId,
                });
              }
            }
          }
        }
      }
      return affectedIds.length;
    }

    case 'dup_bookmarks': {
      if (tableExists(db, 'Bookmark')) {
        const hasPub = columnExists(db, 'Bookmark', 'PublicationLocationId');
        const pubCol = hasPub ? 'PublicationLocationId' : 'LocationId';
        const hasBt = columnExists(db, 'Bookmark', 'BlockType');
        const hasBi = columnExists(db, 'Bookmark', 'BlockIdentifier');
        const btCol = hasBt ? 'IFNULL(BlockType, 0)' : '0';
        const biCol = hasBi ? 'IFNULL(BlockIdentifier, -1)' : '-1';

        const dupSql = `
          SELECT b.BookmarkId FROM Bookmark b
          JOIN (
            SELECT LocationId, ${pubCol} as pubId, ${btCol} as bt, ${biCol} as bi, MIN(BookmarkId) as keepId
            FROM Bookmark
            GROUP BY LocationId, ${pubCol}, ${btCol}, ${biCol}
            HAVING COUNT(*) > 1
          ) g ON b.LocationId = g.LocationId AND b.${pubCol} = g.pubId AND ${hasBt ? 'IFNULL(b.BlockType, 0)' : '0'} = g.bt AND ${hasBi ? 'IFNULL(b.BlockIdentifier, -1)' : '-1'} = g.bi
          WHERE b.BookmarkId <> g.keepId
        `;
        const dups = queryAll<{ BookmarkId: number }>(db, dupSql);
        if (dups.length > 0) {
          execute(db, `DELETE FROM Bookmark WHERE BookmarkId IN (${dups.map((d) => d.BookmarkId).join(',')})`);
        }

        const overSlots = queryAll<{ BookmarkId: number; pubId: number }>(
          db,
          `SELECT BookmarkId, ${pubCol} as pubId FROM Bookmark WHERE Slot >= 10`
        );
        for (const os of overSlots) {
          const occupied = new Set(
            queryAll<{ Slot: number }>(db, `SELECT Slot FROM Bookmark WHERE ${pubCol} = :pid`, { ':pid': os.pubId }).map((r) => r.Slot)
          );
          let freeSlot = -1;
          for (let s = 0; s < 10; s++) {
            if (!occupied.has(s)) {
              freeSlot = s;
              break;
            }
          }
          if (freeSlot !== -1) {
            execute(db, 'UPDATE Bookmark SET Slot = :slot WHERE BookmarkId = :bid', { ':slot': freeSlot, ':bid': os.BookmarkId });
          } else {
            execute(db, 'DELETE FROM Bookmark WHERE BookmarkId = :bid', { ':bid': os.BookmarkId });
          }
        }
      }
      return affectedIds.length;
    }

    default:
      return 0;
  }
}
