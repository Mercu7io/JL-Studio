import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, execute, queryAll, queryOne, exportDatabase, getLibrarySummary } from '../src/lib/jw/sqlite.ts';
import { mergeJwLibraries } from '../src/lib/jw/merge.ts';
import { runHealthChecks, applyHealthFix } from '../src/lib/jw/doctor.ts';
import { packageJwLibrary } from '../src/lib/jw/zip.ts';
import type { IManifest } from '../src/lib/jw/types.ts';

function createBaseSchema(db: any) {
  execute(db, `
    CREATE TABLE Location (
      LocationId INTEGER PRIMARY KEY AUTOINCREMENT,
      BookNumber INTEGER,
      ChapterNumber INTEGER,
      DocumentId INTEGER,
      Track INTEGER,
      IssueTagNumber INTEGER,
      KeySymbol TEXT,
      MepsLanguage INTEGER,
      Type INTEGER,
      Title TEXT
    );
    CREATE TABLE Tag (
      TagId INTEGER PRIMARY KEY AUTOINCREMENT,
      Type INTEGER,
      Name TEXT
    );
    CREATE TABLE TagMap (
      TagMapId INTEGER PRIMARY KEY AUTOINCREMENT,
      PlaylistItemId INTEGER,
      LocationId INTEGER,
      NoteId INTEGER,
      TagId INTEGER,
      Position INTEGER
    );
    CREATE TABLE Note (
      NoteId INTEGER PRIMARY KEY AUTOINCREMENT,
      Guid TEXT UNIQUE,
      UserMarkId INTEGER,
      LocationId INTEGER,
      Title TEXT,
      Content TEXT,
      LastModified TEXT,
      Created TEXT,
      BlockType INTEGER,
      BlockIdentifier INTEGER
    );
    CREATE TABLE UserMark (
      UserMarkId INTEGER PRIMARY KEY AUTOINCREMENT,
      Hash TEXT,
      MigrationStatus INTEGER,
      LocationId INTEGER,
      UserMarkGuid TEXT,
      ColorIndex INTEGER,
      Version INTEGER
    );
    CREATE TABLE BlockRange (
      BlockRangeId INTEGER PRIMARY KEY AUTOINCREMENT,
      BlockType INTEGER,
      Identifier INTEGER,
      StartToken INTEGER,
      EndToken INTEGER,
      UserMarkId INTEGER
    );
    CREATE TABLE Bookmark (
      BookmarkId INTEGER PRIMARY KEY AUTOINCREMENT,
      LocationId INTEGER,
      PublicationLocationId INTEGER,
      Slot INTEGER,
      Title TEXT,
      Snippet TEXT,
      BlockType INTEGER,
      BlockIdentifier INTEGER
    );
    CREATE TABLE InputField (
      LocationId INTEGER,
      TextTag TEXT,
      Value TEXT
    );
  `);
}

test('Comprehensive MERGE: full integration with notes, highlights, duplicates, overrides & exclusions', async () => {
  // 1. Create Primary Database
  const dbA = await openDatabase();
  createBaseSchema(dbA);

  execute(dbA, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (1, 1, 1, 'Genesis 1')`);
  execute(dbA, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 1, 'Faith')`);
  execute(dbA, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created, BlockType, BlockIdentifier) 
                VALUES (1, 'guid-a1', 1, 'Faith in Genesis', 'Primary reflection on Genesis 1:1', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', 1, 1)`);
  execute(dbA, `INSERT INTO TagMap (TagMapId, NoteId, TagId, Position) VALUES (1, 1, 1, 0)`);
  execute(dbA, `INSERT INTO Bookmark (BookmarkId, LocationId, PublicationLocationId, Slot, Title, Snippet, BlockType, BlockIdentifier)
                VALUES (1, 1, 1, 0, 'Genesis Reading', 'In the beginning...', 1, 1)`);

  const primaryBytes = exportDatabase(dbA);
  dbA.close();

  // 2. Create Secondary Database
  const dbB = await openDatabase();
  createBaseSchema(dbB);

  execute(dbB, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (1, 1, 1, 'Genesis 1')`);
  execute(dbB, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (2, 40, 5, 'Matthew 5')`);
  execute(dbB, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 1, 'FAITH')`); // Same name case-insensitive
  execute(dbB, `INSERT INTO Tag (TagId, Type, Name) VALUES (2, 1, 'Hope')`);  // New tag

  // Duplicate note (identical text, anchor, title)
  execute(dbB, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created, BlockType, BlockIdentifier) 
                VALUES (1, 'guid-b-dup', 1, 'Faith in Genesis', 'Primary reflection on Genesis 1:1', '2026-09-02T10:00:00Z', '2026-09-02T10:00:00Z', 1, 1)`);
  // New unique note
  execute(dbB, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created, BlockType, BlockIdentifier) 
                VALUES (2, 'guid-b-new', 2, 'Sermon on Mount', 'Happy are those conscious of spiritual need', '2026-09-02T12:00:00Z', '2026-09-02T12:00:00Z', 1, 3)`);
  // Excluded note (will be skipped via options.excludedNoteGuids)
  execute(dbB, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created, BlockType, BlockIdentifier) 
                VALUES (3, 'guid-b-excluded', 2, 'To Exclude', 'This note should not be in merged DB', '2026-09-02T13:00:00Z', '2026-09-02T13:00:00Z', 1, 4)`);

  // Secondary highlights
  execute(dbB, `INSERT INTO TagMap (TagMapId, NoteId, TagId, Position) VALUES (1, 2, 2, 0)`);
  execute(dbB, `INSERT INTO UserMark (UserMarkId, LocationId, ColorIndex) VALUES (1, 2, 2)`);
  execute(dbB, `INSERT INTO BlockRange (BlockRangeId, BlockType, Identifier, StartToken, EndToken, UserMarkId) 
                VALUES (1, 1, 3, 0, 5, 1)`);

  // Secondary bookmark on Slot 0 (collides with primary slot 0, should shift to next available slot)
  execute(dbB, `INSERT INTO Bookmark (BookmarkId, LocationId, PublicationLocationId, Slot, Title, Snippet, BlockType, BlockIdentifier)
                VALUES (1, 2, 2, 0, 'Matthew Reading', 'Sermon on the mount', 1, 3)`);

  // Secondary study answer
  execute(dbB, `INSERT INTO InputField (LocationId, TextTag, Value) VALUES (2, 'q1', 'My study reflection answer')`);

  const secondaryBytes = exportDatabase(dbB);
  dbB.close();

  // 3. Execute merge
  const primaryManifest: IManifest = {
    name: 'Primary Study',
    creationDate: '2026-09-01',
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: '2026-09-01T10:00:00Z',
      deviceName: 'Phone',
      databaseName: 'userData.db',
      schemaVersion: 14,
    },
  };

  const secondaryManifest: IManifest = {
    name: 'Secondary Study',
    creationDate: '2026-09-02',
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: '2026-09-02T12:00:00Z',
      deviceName: 'Tablet',
      databaseName: 'userData.db',
      schemaVersion: 14,
    },
  };

  const result = await mergeJwLibraries(
    primaryBytes,
    primaryManifest,
    [{ name: 'Tablet.jwlibrary', dbBytes: secondaryBytes, manifest: secondaryManifest }],
    {
      excludedNoteGuids: ['guid-b-excluded'],
      noteOverrides: {
        'guid-b-new': { title: 'Overridden Sermon on Mount' },
      },
      doctorCheck: true,
    }
  );

  assert.ok(result.mergedBlob, 'Must produce a merged .jwlibrary blob');
  assert.ok(result.mergedDbBytes.length > 0, 'Must produce non-empty database bytes');
  assert.equal(result.stats.notesAdded, 1, 'Only 1 new note should be added (1 duplicate unified, 1 excluded)');
  assert.equal(result.stats.notesMerged, 1, '1 duplicate note should be unified');

  // Verify merged database contents
  const mergedDb = await openDatabase(result.mergedDbBytes);
  const notes = queryAll<any>(mergedDb, 'SELECT * FROM Note ORDER BY NoteId ASC');
  assert.equal(notes.length, 2, 'Should contain exactly 2 notes: 1 original primary, 1 added from secondary');

  const addedNote = notes.find((n: any) => n.Guid === 'guid-b-new');
  assert.ok(addedNote, 'Secondary note must exist in merged database');
  assert.equal(addedNote.Title, 'Overridden Sermon on Mount', 'Note title override must be applied');

  const excludedNote = notes.find((n: any) => n.Guid === 'guid-b-excluded');
  assert.equal(excludedNote, undefined, 'Excluded note must NOT be in merged database');

  // Verify tags deduplication
  const tags = queryAll<any>(mergedDb, 'SELECT * FROM Tag');
  assert.equal(tags.length, 2, 'Faith and Hope tags should exist without duplicate Faith');

  // Verify Bookmarks
  const bookmarks = queryAll<any>(mergedDb, 'SELECT * FROM Bookmark');
  assert.equal(bookmarks.length, 2, 'Both bookmarks should exist');

  // Verify InputField
  const inputFields = queryAll<any>(mergedDb, 'SELECT * FROM InputField');
  assert.equal(inputFields.length, 1, 'Study answer must be merged');
  assert.equal(inputFields[0].Value, 'My study reflection answer');

  mergedDb.close();
});

test('Comprehensive PLAYLIST MERGE: merges playlists, maps items and positions, preserves media and markers', async () => {
  function setupPlaylistTables(db: any) {
    createBaseSchema(db);
    execute(db, `
      CREATE TABLE IF NOT EXISTS PlaylistItem (
        PlaylistItemId INTEGER PRIMARY KEY AUTOINCREMENT,
        Label TEXT,
        StartTrimOffsetTicks INTEGER,
        EndTrimOffsetTicks INTEGER,
        Accuracy INTEGER,
        EndAction INTEGER,
        ThumbnailFilePath TEXT
      );
      CREATE TABLE IF NOT EXISTS PlaylistItemAccuracy (
        PlaylistItemAccuracyId INTEGER PRIMARY KEY,
        Description TEXT
      );
      CREATE TABLE IF NOT EXISTS IndependentMedia (
        IndependentMediaId INTEGER PRIMARY KEY AUTOINCREMENT,
        OriginalFilename TEXT,
        FilePath TEXT,
        MimeType TEXT,
        Hash TEXT
      );
      CREATE TABLE IF NOT EXISTS PlaylistItemIndependentMediaMap (
        PlaylistItemId INTEGER,
        IndependentMediaId INTEGER,
        DurationTicks INTEGER
      );
    `);
  }

  // 1. Primary DB with Playlist "Meeting Songs" having 1 item "Song 105"
  const dbA = await openDatabase();
  setupPlaylistTables(dbA);
  execute(dbA, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 2, 'Meeting Songs')`);
  execute(dbA, `INSERT INTO PlaylistItem (PlaylistItemId, Label, Accuracy, EndAction) VALUES (1, 'Song 105', 1, 0)`);
  execute(dbA, `INSERT INTO TagMap (TagMapId, PlaylistItemId, TagId, Position) VALUES (1, 1, 1, 0)`);
  const primaryBytes = exportDatabase(dbA);
  dbA.close();

  // 2. Secondary DB with:
  // - overlapping Playlist "Meeting Songs" having 1 new item "Song 120"
  // - new Playlist "Family Study" having 1 item "Creation Video"
  const dbB = await openDatabase();
  setupPlaylistTables(dbB);
  execute(dbB, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 2, 'Meeting Songs')`);
  execute(dbB, `INSERT INTO PlaylistItem (PlaylistItemId, Label, Accuracy, EndAction) VALUES (1, 'Song 120', 1, 0)`);
  execute(dbB, `INSERT INTO TagMap (TagMapId, PlaylistItemId, TagId, Position) VALUES (1, 1, 1, 0)`);

  execute(dbB, `INSERT INTO Tag (TagId, Type, Name) VALUES (2, 2, 'Family Study')`);
  execute(dbB, `INSERT INTO PlaylistItem (PlaylistItemId, Label, Accuracy, EndAction) VALUES (2, 'Creation Video', 1, 0)`);
  execute(dbB, `INSERT INTO TagMap (TagMapId, PlaylistItemId, TagId, Position) VALUES (2, 2, 2, 0)`);

  const secondaryBytes = exportDatabase(dbB);
  dbB.close();

  const manifestA: IManifest = {
    name: 'Primary Backup',
    creationDate: '2026-09-01',
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: '2026-09-01T10:00:00Z',
      deviceName: 'Phone',
      databaseName: 'userData.db',
      schemaVersion: 14,
    },
  };

  const manifestB: IManifest = {
    name: 'Secondary Backup',
    creationDate: '2026-09-02',
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: '2026-09-02T10:00:00Z',
      deviceName: 'Tablet',
      databaseName: 'userData.db',
      schemaVersion: 14,
    },
  };

  const result = await mergeJwLibraries(
    primaryBytes,
    manifestA,
    [{ name: 'Tablet.jwlibrary', dbBytes: secondaryBytes, manifest: manifestB }],
    { doctorCheck: false }
  );

  assert.ok(result.mergedBlob);
  assert.equal(result.stats.playlistsMerged, 2, 'Must merge 2 new playlist items');
  assert.equal(result.details.mergedPlaylists.length, 2, 'Must record merged playlist details');

  const mergedDb = await openDatabase(result.mergedDbBytes);
  // Tags of type 2: "Meeting Songs" should be unified, "Family Study" added
  const playlistTags = queryAll<any>(mergedDb, 'SELECT * FROM Tag WHERE Type = 2 ORDER BY TagId ASC');
  assert.equal(playlistTags.length, 2, 'Should have 2 distinct playlist tags');
  assert.equal(playlistTags[0].Name, 'Meeting Songs');
  assert.equal(playlistTags[1].Name, 'Family Study');

  // PlaylistItem table: should have 3 items (Song 105, Song 120, Creation Video)
  const playlistItems = queryAll<any>(mergedDb, 'SELECT * FROM PlaylistItem ORDER BY PlaylistItemId ASC');
  assert.equal(playlistItems.length, 3, 'Should have 3 playlist items total');

  // TagMap for "Meeting Songs" should have 2 items at position 0 and 1
  const meetingTagMaps = queryAll<any>(mergedDb, 'SELECT * FROM TagMap WHERE TagId = :tid ORDER BY Position ASC', { ':tid': playlistTags[0].TagId });
  assert.equal(meetingTagMaps.length, 2, 'Meeting Songs playlist should contain 2 items');
  assert.equal(meetingTagMaps[0].Position, 0);
  assert.equal(meetingTagMaps[1].Position, 1);

  // TagMap for "Family Study" should have 1 item at position 0
  const familyTagMaps = queryAll<any>(mergedDb, 'SELECT * FROM TagMap WHERE TagId = :tid ORDER BY Position ASC', { ':tid': playlistTags[1].TagId });
  assert.equal(familyTagMaps.length, 1, 'Family Study playlist should contain 1 item');
  assert.equal(familyTagMaps[0].Position, 0);

  // Check library summary playlistsCount
  const summary = getLibrarySummary(mergedDb, manifestA, result.mergedDbBytes.length);
  assert.equal(summary.playlistsCount, 2, 'Summary should report 2 playlists');

  mergedDb.close();
});

test('Comprehensive STATS: metrics, highlight colors, and Bible distribution', async () => {
  const db = await openDatabase();
  createBaseSchema(db);

  execute(db, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (1, 1, 1, 'Genesis 1')`);
  execute(db, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (2, 19, 23, 'Psalm 23')`);

  execute(db, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 1, 'Comfort')`);
  execute(db, `INSERT INTO Tag (TagId, Type, Name) VALUES (2, 2, 'My Playlist')`); // Playlist tag (Type 2)

  execute(db, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created) 
                VALUES (1, 'g1', 1, 'Creation', 'God created heavens and earth', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`);
  execute(db, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created) 
                VALUES (2, 'g2', 2, 'Shepherd', 'Jehovah is my Shepherd', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`);

  execute(db, `INSERT INTO TagMap (TagMapId, NoteId, TagId) VALUES (1, 2, 1)`);

  execute(db, `INSERT INTO UserMark (UserMarkId, LocationId, ColorIndex) VALUES (1, 1, 1)`); // Yellow
  execute(db, `INSERT INTO UserMark (UserMarkId, LocationId, ColorIndex) VALUES (2, 2, 1)`); // Yellow
  execute(db, `INSERT INTO UserMark (UserMarkId, LocationId, ColorIndex) VALUES (3, 2, 2)`); // Green

  const manifest: IManifest = {
    name: 'Stats Test Library',
    creationDate: '2026-09-04',
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: '2026-09-04T00:00:00Z',
      deviceName: 'Device',
      databaseName: 'userData.db',
      schemaVersion: 14,
    },
  };

  const summary = getLibrarySummary(db, manifest, 1024);
  assert.equal(summary.notesCount, 2);
  assert.equal(summary.userMarksCount, 3);
  assert.equal(summary.tagsCount, 1, 'Must only count Type 1 personal study tags');
  assert.equal(summary.playlistsCount, 1, 'Must count Type 2 as playlist');

  // Verify Highlights by Color query
  const colorRows = queryAll<{ ColorIndex: number; count: number }>(
    db,
    `SELECT ColorIndex, COUNT(*) as count FROM UserMark GROUP BY ColorIndex ORDER BY ColorIndex ASC`
  );
  assert.equal(colorRows.length, 2);
  assert.equal(colorRows.find((r) => r.ColorIndex === 1)?.count, 2);
  assert.equal(colorRows.find((r) => r.ColorIndex === 2)?.count, 1);

  // Verify Top Bible Books query
  const bibleRows = queryAll<{ BookNumber: number; count: number }>(
    db,
    `SELECT l.BookNumber, COUNT(n.NoteId) as count
     FROM Note n
     JOIN Location l ON n.LocationId = l.LocationId
     WHERE l.BookNumber IS NOT NULL AND l.BookNumber > 0
     GROUP BY l.BookNumber
     ORDER BY count DESC`
  );
  assert.equal(bibleRows.length, 2);

  // Verify Top Tags query with Type=1 filter (playlists excluded)
  const topTagRows = queryAll<{ Name: string; count: number }>(
    db,
    `SELECT t.Name, COUNT(tm.TagMapId) as count
     FROM Tag t
     JOIN TagMap tm ON t.TagId = tm.TagId
     WHERE t.Type = 1
     GROUP BY t.TagId, t.Name
     ORDER BY count DESC`
  );
  assert.equal(topTagRows.length, 1);
  assert.equal(topTagRows[0].Name, 'Comfort');

  db.close();
});

test('Comprehensive EXPLORER: note search, editing, deletion, tag manager & doctor health checks', async () => {
  const db = await openDatabase();
  createBaseSchema(db);

  execute(db, `INSERT INTO Location (LocationId, BookNumber, ChapterNumber, Title) VALUES (1, 1, 1, 'Genesis 1')`);
  execute(db, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 1, 'OriginalTag')`);
  execute(db, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content, LastModified, Created) 
                VALUES (1, 'guid-1', 1, 'Faith in Trials', 'Perseverance produces approved condition', '2026-09-04T00:00:00Z', '2026-09-04T00:00:00Z')`);
  execute(db, `INSERT INTO TagMap (TagMapId, NoteId, TagId) VALUES (1, 1, 1)`);

  // 1. Direct Keyword Search (Direct note search without LLM overhead)
  const allNotes = [
    {
      noteId: 1,
      title: 'Faith in Trials',
      content: 'Perseverance produces approved condition',
      locationTitle: 'Genesis 1',
      tags: ['OriginalTag'],
    },
    {
      noteId: 2,
      title: 'Love and Kindness',
      content: 'Love is patient and kind',
      locationTitle: '1 Corinthians 13',
      tags: ['Love'],
    },
  ];

  const searchKeyword = 'perseverance';
  const q = searchKeyword.toLowerCase();
  const searchResults = allNotes.filter(
    (n) =>
      (n.title && n.title.toLowerCase().includes(q)) ||
      (n.content && n.content.toLowerCase().includes(q)) ||
      (n.locationTitle && n.locationTitle.toLowerCase().includes(q)) ||
      n.tags.some((t) => t.toLowerCase().includes(q))
  );
  assert.ok(searchResults.length > 0, 'Direct search should match note');
  assert.equal(searchResults[0].noteId, 1, 'Top result should be note 1');

  // 2. Note Editing
  execute(
    db,
    'UPDATE Note SET Title = :t, Content = :c, LastModified = :lm WHERE NoteId = :id',
    {
      ':t': 'Updated Title',
      ':c': 'Updated Content',
      ':lm': new Date().toISOString(),
      ':id': 1,
    }
  );
  const updatedNote = queryOne<any>(db, 'SELECT * FROM Note WHERE NoteId = 1');
  assert.equal(updatedNote.Title, 'Updated Title');
  assert.equal(updatedNote.Content, 'Updated Content');

  // 3. Tag Renaming
  execute(db, 'UPDATE Tag SET Name = :name WHERE TagId = :id', { ':name': 'RenamedTag', ':id': 1 });
  const renamedTag = queryOne<any>(db, 'SELECT * FROM Tag WHERE TagId = 1');
  assert.equal(renamedTag.Name, 'RenamedTag');

  // 4. Note Deletion
  execute(db, 'DELETE FROM TagMap WHERE NoteId = 1');
  execute(db, 'DELETE FROM Note WHERE NoteId = 1');
  const deletedNote = queryOne<any>(db, 'SELECT * FROM Note WHERE NoteId = 1');
  assert.equal(deletedNote, null, 'Note must be deleted');
  const deletedTagMap = queryOne<any>(db, 'SELECT * FROM TagMap WHERE NoteId = 1');
  assert.equal(deletedTagMap, null, 'TagMap reference must be deleted');

  // 5. Library Doctor diagnostics & repair
  // Add an empty note and an orphaned tag map
  execute(db, `INSERT INTO Note (NoteId, Guid, LocationId, Title, Content) VALUES (2, 'guid-empty', 1, '', '')`);
  execute(db, `INSERT INTO TagMap (TagMapId, NoteId, TagId) VALUES (2, 999, 1)`); // NoteId 999 does not exist

  const healthIssues = runHealthChecks(db);
  const emptyNoteIssue = healthIssues.find((h) => h.key === 'empty_notes');
  assert.ok(emptyNoteIssue && emptyNoteIssue.count === 1, 'Doctor should detect empty note');

  const orphanTagMapIssue = healthIssues.find((h) => h.key === 'orph_tm');
  assert.ok(orphanTagMapIssue && orphanTagMapIssue.count === 1, 'Doctor should detect orphaned tag map');

  // Fix issues
  applyHealthFix(db, 'empty_notes', emptyNoteIssue.affectedIds);
  applyHealthFix(db, 'orph_tm', orphanTagMapIssue.affectedIds);

  const postFixIssues = runHealthChecks(db);
  assert.equal(postFixIssues.find((h) => h.key === 'empty_notes')?.count, 0, 'Empty note must be pruned');
  assert.equal(postFixIssues.find((h) => h.key === 'orph_tm')?.count, 0, 'Orphaned tag map must be pruned');

  db.close();
});

test('Favorites MERGE: unifies Type = 0 system tags, deduplicates publications in TagMap, and self-heals duplicate tags', async () => {
  const dbA = await openDatabase();
  createBaseSchema(dbA);
  // Base A: French device with "Favoris"
  execute(dbA, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (1, 'nwtsty', 1, 'Bible')`);
  execute(dbA, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (2, 'es26', 1, 'Daily Text')`);
  execute(dbA, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 0, 'Favoris')`);
  execute(dbA, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (1, 1, 1, 0)`);
  execute(dbA, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (2, 2, 1, 1)`);

  const primaryBytes = exportDatabase(dbA);
  dbA.close();

  const dbB = await openDatabase();
  createBaseSchema(dbB);
  // Base B: English device with "Favorites", same Bible publication and a new Songbook publication
  execute(dbB, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (10, 'nwtsty', 1, 'Bible')`);
  execute(dbB, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (20, 'sjj', 1, 'Songs')`);
  execute(dbB, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 0, 'Favorites')`);
  execute(dbB, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (1, 10, 1, 0)`);
  execute(dbB, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (2, 20, 1, 1)`);

  const secBytes = exportDatabase(dbB);
  dbB.close();

  const dummyManifest: IManifest = {
    name: 'test',
    creationDate: new Date().toISOString(),
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: new Date().toISOString(),
      deviceName: 'Device',
      databaseName: 'userData.db',
      schemaVersion: 1,
    },
  };

  const mergeResult = await mergeJwLibraries(primaryBytes, dummyManifest, [
    { name: 'Secondary', dbBytes: secBytes, manifest: dummyManifest },
  ]);

  const mergedDb = await openDatabase(mergeResult.mergedDbBytes);

  // 1. Verify exactly 1 Favorite tag (Type = 0)
  const favTags = queryAll<any>(mergedDb, 'SELECT * FROM Tag WHERE Type = 0');
  assert.equal(favTags.length, 1, 'There must be exactly ONE system favorite tag of Type 0');
  assert.equal(favTags[0].Name, 'Favoris');

  // 2. Verify TagMap has no duplicate publications (Bible should be listed once, not twice)
  const tagMaps = queryAll<any>(mergedDb, 'SELECT * FROM TagMap WHERE TagId = :tid ORDER BY Position ASC', { ':tid': favTags[0].TagId });
  assert.equal(tagMaps.length, 3, 'TagMap should contain 3 items (Bible, Daily Text, Songs)');
  
  // Verify distinct locations in TagMap
  const locIds = tagMaps.map((tm: any) => tm.LocationId);
  const uniqueLocIds = new Set(locIds);
  assert.equal(locIds.length, uniqueLocIds.size, 'Each publication must be mapped at most once to favorites');

  mergedDb.close();
});

test('Bookmarks MERGE: deduplicates bookmarks on same passage across differing slots, and respects 0..9 slot boundary', async () => {
  const dbA = await openDatabase();
  createBaseSchema(dbA);
  execute(dbA, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (1, 'nwtsty', 1, 'Bible')`);
  execute(dbA, `INSERT INTO Location (LocationId, KeySymbol, BookNumber, ChapterNumber, Type, Title) VALUES (2, 'nwtsty', 1, 1, 0, 'Genesis 1')`);
  // Primary has Genesis 1 on Slot 0
  execute(dbA, `INSERT INTO Bookmark (BookmarkId, LocationId, PublicationLocationId, Slot, Title, BlockType, BlockIdentifier)
                VALUES (1, 2, 1, 0, 'Genèse 1', 0, NULL)`);

  const primaryBytes = exportDatabase(dbA);
  dbA.close();

  const dbB = await openDatabase();
  createBaseSchema(dbB);
  execute(dbB, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (10, 'nwtsty', 1, 'Bible')`);
  execute(dbB, `INSERT INTO Location (LocationId, KeySymbol, BookNumber, ChapterNumber, Type, Title) VALUES (20, 'nwtsty', 1, 1, 0, 'Genesis 1')`);
  execute(dbB, `INSERT INTO Location (LocationId, KeySymbol, BookNumber, ChapterNumber, Type, Title) VALUES (21, 'nwtsty', 1, 2, 0, 'Genesis 2')`);
  // Secondary has same Genesis 1 but on Slot 3, plus Genesis 2 on Slot 0
  execute(dbB, `INSERT INTO Bookmark (BookmarkId, LocationId, PublicationLocationId, Slot, Title, BlockType, BlockIdentifier)
                VALUES (1, 20, 10, 3, 'Genèse 1', 0, NULL)`);
  execute(dbB, `INSERT INTO Bookmark (BookmarkId, LocationId, PublicationLocationId, Slot, Title, BlockType, BlockIdentifier)
                VALUES (2, 21, 10, 0, 'Genèse 2', 0, NULL)`);

  const secBytes = exportDatabase(dbB);
  dbB.close();

  const dummyManifest: IManifest = {
    name: 'test',
    creationDate: new Date().toISOString(),
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: new Date().toISOString(),
      deviceName: 'Device',
      databaseName: 'userData.db',
      schemaVersion: 1,
    },
  };

  const mergeResult = await mergeJwLibraries(primaryBytes, dummyManifest, [
    { name: 'Secondary', dbBytes: secBytes, manifest: dummyManifest },
  ]);

  const mergedDb = await openDatabase(mergeResult.mergedDbBytes);

  // 1. Genesis 1 must exist exactly ONCE (no duplicate on slot 3 or shifted slot)
  const bms = queryAll<any>(mergedDb, 'SELECT * FROM Bookmark ORDER BY Slot ASC');
  assert.equal(bms.length, 2, 'There should be exactly 2 bookmarks (Genesis 1 and Genesis 2)');

  // Slot 0 is Genesis 1, Genesis 2 takes next available slot (slot 1)
  assert.equal(bms[0].Slot, 0);
  assert.equal(bms[0].Title, 'Genèse 1');
  assert.equal(bms[1].Slot, 1);
  assert.equal(bms[1].Title, 'Genèse 2');

  // Verify all slots are within [0..9]
  for (const bm of bms) {
    assert.ok(bm.Slot >= 0 && bm.Slot < 10, `Slot ${bm.Slot} must be within 0..9 for JW Library compatibility`);
  }

  mergedDb.close();
});

test('Doctor health check: detects and repairs duplicate favorite tags & duplicate favorite publications in TagMap', async () => {
  const db = await openDatabase();
  createBaseSchema(db);

  // Setup database in corrupted state: 2 Type 0 tags ("Favoris" and "Favorites"), and duplicate publication in TagMap
  execute(db, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (1, 'nwtsty', 1, 'Bible')`);
  execute(db, `INSERT INTO Location (LocationId, KeySymbol, Type, Title) VALUES (2, 'es26', 1, 'Daily Text')`);

  execute(db, `INSERT INTO Tag (TagId, Type, Name) VALUES (1, 0, 'Favoris')`);
  execute(db, `INSERT INTO Tag (TagId, Type, Name) VALUES (2, 0, 'Favorites')`);

  // Location 1 is mapped to Tag 1 AND Tag 2
  execute(db, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (1, 1, 1, 0)`);
  execute(db, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (2, 1, 2, 0)`);
  // Location 2 is mapped to Tag 1 twice (duplicate publication)
  execute(db, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (3, 2, 1, 1)`);
  execute(db, `INSERT INTO TagMap (TagMapId, LocationId, TagId, Position) VALUES (4, 2, 1, 2)`);

  // 1. Doctor must detect dup_fav_tags
  const issues = runHealthChecks(db);
  const favIssue = issues.find((i) => i.key === 'dup_fav_tags');
  assert.ok(favIssue, 'Doctor must detect duplicate favorite tags and map entries');
  assert.ok(favIssue.count > 0, `Expected duplicate count > 0, got ${favIssue.count}`);

  // 2. Doctor repairs the issue
  applyHealthFix(db, 'dup_fav_tags', favIssue.affectedIds);

  // 3. Post-repair verification
  const postIssues = runHealthChecks(db);
  const postFavIssue = postIssues.find((i) => i.key === 'dup_fav_tags');
  assert.equal(postFavIssue, undefined, 'Duplicate favorites issue must be completely resolved');

  const remainingTags = queryAll<any>(db, 'SELECT * FROM Tag WHERE Type = 0');
  assert.equal(remainingTags.length, 1, 'Must have exactly 1 favorite tag remaining');

  const remainingMaps = queryAll<any>(db, 'SELECT * FROM TagMap WHERE TagId = :tid', { ':tid': remainingTags[0].TagId });
  assert.equal(remainingMaps.length, 2, 'Must have exactly 2 distinct favorite publications (Bible and Daily Text)');

  db.close();
});

test('packageJwLibrary MIME type: emits application/octet-stream to prevent mobile browsers appending .zip', async () => {
  const db = await openDatabase();
  createBaseSchema(db);
  const dbBytes = exportDatabase(db);
  db.close();

  const manifest: IManifest = {
    name: 'test_backup',
    creationDate: new Date().toISOString(),
    version: 1,
    type: 0,
    userDataBackup: {
      lastModifiedDate: new Date().toISOString(),
      deviceName: 'TestDevice',
      databaseName: 'userData.db',
      schemaVersion: 1,
    },
  };

  const blob = await packageJwLibrary(dbBytes, manifest);
  assert.equal(blob.type, 'application/octet-stream', 'Blob MIME type must be application/octet-stream');
});


