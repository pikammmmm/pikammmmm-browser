/**
 * Tiny pub/sub for "the bookmarks DB just changed". The chrome-side
 * BookmarkBar listens on this so it refreshes after Settings imports,
 * star-button toggles, deletions, etc. — without needing every mutation
 * site to know about every consumer.
 */
const EVENT = 'bookmarks-changed';

export function notifyBookmarksChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}
