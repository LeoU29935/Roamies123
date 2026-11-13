// Focus mode: what counts as a distraction, and when a nudge comes. Run: npm test
import assert from 'node:assert/strict';
import { DEFAULT_DISTRACTIONS, check, distraction, parseDistractions, startBlock, NUDGE_GAP_MS } from '../focus.mjs';

const L = DEFAULT_DISTRACTIONS;
assert.equal(distraction({ app: 'Google Chrome', title: 'Lo-fi beats - YouTube', url: 'https://www.youtube.com/watch?v=1' }, L), 'youtube.com');
assert.equal(distraction({ app: 'Safari', title: 'Watch', url: 'https://m.youtube.com/' }, L), 'youtube.com', 'subdomain');
assert.equal(distraction({ app: 'Firefox', title: 'Lo-fi beats – YouTube — Mozilla Firefox' }, L), 'YouTube', 'by title when no address');
assert.equal(distraction({ app: 'Arc', title: 'r/gaming', url: 'https://old.reddit.com/r/gaming' }, L), 'reddit.com');
assert.equal(distraction({ app: 'Steam', title: 'Steam' }, L), 'Steam');
assert.equal(distraction({ app: 'steamwebhelper', title: 'Library' }, L), 'Steam', 'app name contains it');
assert.equal(distraction({ app: 'Minecraft Launcher', title: 'Minecraft' }, L), 'Minecraft');
assert.equal(distraction({ app: 'Code', title: 'focus.mjs — Roamies' }, L), null, 'work is fine');
assert.equal(distraction({ app: 'Chrome', title: 'youtube-dl docs', url: 'https://github.com/ytdl-org/youtube-dl' }, L), null, 'an address, not the word');
assert.equal(distraction({ app: 'Chrome', title: 'Docs', url: 'https://notyoutube.com/' }, L), null, 'not a lookalike domain');
assert.equal(distraction({ app: 'Chrome', title: 'Reading about Steampunk', url: 'https://en.wikipedia.org/wiki/Steampunk' }, L), null, 'whole words in titles');
assert.equal(distraction({ app: 'Roamies', title: 'YouTube' }, L), null, 'never Roamies itself');
assert.equal(distraction(null, L), null);

assert.deepEqual(parseDistractions('https://www.chess.com/play, Steam;  news.ycombinator.com/item?id=1\nsteam, x'),
  ['chess.com', 'Steam', 'news.ycombinator.com'], 'cleaned, deduplicated, too-short dropped');
assert.deepEqual(parseDistractions(''), []);
assert.equal(distraction({ app: 'Chrome', title: 'Play', url: 'https://www.chess.com/play' }, parseDistractions('chess.com')), 'chess.com');

const t0 = 1_000_000;
const b = startBlock(45, ' the slides ', t0);
assert.equal(b.minutes, 45); assert.equal(b.task, 'the slides'); assert.equal(b.until, t0 + 45 * 60_000);
assert.equal(startBlock(1).minutes, 5, 'at least 5 minutes');
assert.equal(startBlock(999).minutes, 240, 'at most 4 hours');
assert.equal(startBlock('x').minutes, 25, 'unreadable: 25');

const yt = { app: 'Chrome', title: 'x - YouTube', url: 'https://youtube.com/' }, work = { app: 'Keynote', title: 'Slides' };
assert.deepEqual(check(b, yt, L, t0 + 1000), {}, 'a glance');
assert.deepEqual(check(b, work, L, t0 + 21000), {}, 'back to work');
assert.deepEqual(check(b, yt, L, t0 + 41000), {});
assert.deepEqual(check(b, yt, L, t0 + 61000), { nudge: 'youtube.com' }, 'stayed: nudge');
assert.deepEqual(check(b, yt, L, t0 + 81000), {}, 'not again right away');
assert.deepEqual(check(b, yt, L, t0 + 61000 + NUDGE_GAP_MS), { nudge: 'youtube.com' }, 'again after the gap');
assert.equal(b.drifts, 2, 'two separate drifts counted');
assert.deepEqual(check(b, work, L, t0 + 45 * 60_000), { end: true }, 'time up');
console.log('focus tests: passed');
