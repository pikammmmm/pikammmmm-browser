import { describe, expect, it } from 'vitest';

// Re-implement the parser inline so we can unit-test it without booting Electron.
// This is a copy of the regex+JSON-shape logic in ClaudeService.parseJsonArray.
function parseJsonArray(text: string): Array<{ title: string; url: string; snippet: string }> | null {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(arr)) return null;
    return arr
      .filter(
        (x): x is { title: string; url: string; snippet?: string } =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as { title: unknown }).title === 'string' &&
          typeof (x as { url: unknown }).url === 'string',
      )
      .map((x) => ({
        title: x.title,
        url: x.url,
        snippet: typeof x.snippet === 'string' ? x.snippet : '',
      }));
  } catch {
    return null;
  }
}

describe('parseJsonArray', () => {
  it('extracts a clean JSON array', () => {
    const text = '[{"title":"a","url":"https://a","snippet":"s"}]';
    expect(parseJsonArray(text)).toEqual([{ title: 'a', url: 'https://a', snippet: 's' }]);
  });

  it('extracts JSON embedded in chatter', () => {
    const text = 'Here are the results: [{"title":"x","url":"https://x"}] hope this helps';
    expect(parseJsonArray(text)).toEqual([{ title: 'x', url: 'https://x', snippet: '' }]);
  });

  it('rejects non-array', () => {
    expect(parseJsonArray('not json at all')).toBeNull();
  });

  it('drops malformed entries but keeps valid ones', () => {
    const text = '[{"title":"a","url":"https://a"},{"badly":"shaped"}]';
    expect(parseJsonArray(text)).toEqual([{ title: 'a', url: 'https://a', snippet: '' }]);
  });
});
