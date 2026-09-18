'use strict';

// Reverse of MuxTask.bs `_minify`. The Roku Mux SDK collapses each
// snake_case property name into a short code before sending the beacon:
//   - the FIRST word becomes a single-letter code (_firstWords)
//   - every SUBSEQUENT word becomes a two-letter code (_subsequentWords)
//   - a numeric word is kept verbatim (e.g. custom_1 -> c1)
//   - an unknown word is wrapped in underscores (e.g. _correlation_id stays put)
// Decoding walks the code left-to-right and rebuilds the original name, so the
// GUI can show real property names (player_country_code) instead of codes (pcycd).
// Source of truth: dce-roku/components/tasks/MuxTask/MuxTask.bs

// _firstWords (word -> code) from the SDK. Two words collapse to "a"
// (property/env); we decode "a" as "env" since that is the modern Mux name
// (env_key). The original could also be property_key.
const FIRST_WORDS = {
  property: 'a', env: 'a', beacon: 'b', custom: 'c', ad: 'd', event: 'e',
  experiment: 'f', mux: 'm', player: 'p', retry: 'r', session: 's',
  timestamp: 't', viewer: 'u', video: 'v', page: 'w', view: 'x', sub: 'y',
};

const SUBSEQUENT_WORDS = {
  ad: 'ad', aggregate: 'ag', api: 'ap', application: 'al', audio: 'ao',
  architecture: 'ar', asset: 'as', autoplay: 'au', break: 'br', codec: 'cc',
  code: 'cd', category: 'cg', config: 'cn', count: 'co', complete: 'cp',
  connection: 'cx', content: 'ct', current: 'cu', country: 'cy', context: 'cz',
  downscaling: 'dg', domain: 'dm', cdn: 'dn', downscale: 'do', duration: 'du',
  device: 'dv', drm: 'dr', dropped: 'dp', encoding: 'ec', end: 'en',
  engine: 'eg', embed: 'em', error: 'er', events: 'ev', expires: 'ex',
  first: 'fi', family: 'fm', format: 'ft', fps: 'fp', frequency: 'fq',
  frame: 'fr', fullscreen: 'fs', host: 'ho', hostname: 'hn', height: 'ht',
  id: 'id', init: 'ii', instance: 'in', ip: 'ip', is: 'is', key: 'ke',
  language: 'la', live: 'li', load: 'lo', max: 'ma', message: 'me', mime: 'mi',
  midroll: 'ml', manufacturer: 'mn', model: 'mo', mux: 'mx', name: 'nm',
  number: 'no', on: 'on', os: 'os', paused: 'pa', playback: 'pb',
  producer: 'pd', percentage: 'pe', played: 'pf', playhead: 'ph', plugin: 'pi',
  preroll: 'pl', poster: 'po', preload: 'pr', property: 'py', rate: 'ra',
  requested: 'rd', rebuffer: 're', ratio: 'ro', request: 'rq', requests: 'rs',
  sample: 'sa', session: 'se', seek: 'sk', stream: 'sm', source: 'so',
  sequence: 'sq', series: 'sr', start: 'st', startup: 'su', server: 'sv',
  software: 'sw', subtitle: 'sb', tag: 'ta', tech: 'tc', time: 'ti',
  total: 'tl', to: 'to', title: 'tt', type: 'ty', track: 'tr', upscaling: 'ug',
  upscale: 'up', url: 'ur', user: 'us', variant: 'va', viewed: 'vd',
  video: 'vi', version: 've', view: 'vw', viewer: 'vr', width: 'wd',
  watch: 'wa', waiting: 'wt',
};

function invert(map) {
  const out = {};
  for (const word of Object.keys(map)) out[map[word]] = word;
  return out;
}

const FIRST_REV = invert(FIRST_WORDS); // single-char code -> word
const SUB_REV = invert(SUBSEQUENT_WORDS); // two-char code -> word

const decodeCache = new Map();

// Expand a single minified key back to its original snake_case property name.
// Returns the input unchanged if it does not look like a Mux code (e.g. keys
// the SDK left literal such as `_correlation_id` or `_source_ty`).
function decodeKey(key) {
  if (typeof key !== 'string' || key === '') return key;
  if (decodeCache.has(key)) return decodeCache.get(key);

  let decoded;
  if (key === '__') {
    decoded = '_';
  } else if (!FIRST_REV[key[0]]) {
    // Leading underscore or unknown first code -> SDK kept it literal.
    decoded = key;
  } else {
    const parts = [FIRST_REV[key[0]]];
    let i = 1;
    let ok = true;
    while (i < key.length) {
      const ch = key[i];
      if (ch >= '0' && ch <= '9') {
        let j = i;
        while (j < key.length && key[j] >= '0' && key[j] <= '9') j++;
        parts.push(key.slice(i, j));
        i = j;
      } else if (ch === '_') {
        // _word_ : an unknown word the SDK wrapped in underscores.
        const j = key.indexOf('_', i + 1);
        if (j === -1) { parts.push(key.slice(i + 1)); i = key.length; }
        else { parts.push(key.slice(i + 1, j)); i = j + 1; }
      } else {
        const code = key.slice(i, i + 2);
        const word = SUB_REV[code];
        if (word) { parts.push(word); i += 2; }
        else { ok = false; break; } // not a real code -> bail to raw key
      }
    }
    decoded = ok ? parts.join('_') : key;
  }

  decodeCache.set(key, decoded);
  return decoded;
}

// Decode every key of one raw event object. Keys that collide after decoding
// keep the first value seen (matches the SDK, where codes are unique anyway).
function decodeEvent(rawEvent) {
  const out = {};
  if (!rawEvent || typeof rawEvent !== 'object') return out;
  for (const k of Object.keys(rawEvent)) {
    const dk = decodeKey(k);
    if (!(dk in out)) out[dk] = rawEvent[k];
  }
  return out;
}

// Curated columns shown in the grid (in order). Everything else is available
// in the row detail panel. `key` is the decoded property name.
const CURATED_COLUMNS = [
  { key: 'event', label: 'event', width: 130 },
  { key: 'player_sequence_number', label: 'player_seq', width: 80, num: true },
  { key: 'view_sequence_number', label: 'view_seq', width: 75, num: true },
  { key: 'player_playhead_time', label: 'playhead', width: 140, combo: 'playhead' },
  { key: 'video_title', label: 'video_title', width: 180 },
  { key: 'view_id', label: 'view_id', width: 130 },
  { key: 'player_error_code', label: 'error_code', width: 90 },
  { key: 'player_error_message', label: 'error_message', width: 200 },
];

module.exports = {
  decodeKey,
  decodeEvent,
  CURATED_COLUMNS,
};
