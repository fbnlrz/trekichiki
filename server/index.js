// Famichiki Counter — built plugin entry, runs in an isolated child process.
// One row per Famichiki eaten, per user, in the plugin's own SQLite file.
const { definePlugin } = require('trek-plugin-sdk');

const MILESTONES = [10, 25, 50, 100, 250, 500];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_RE = /^[A-Za-z]{3}$/;
const DEFAULT_PRICE = 198;
const DEFAULT_CURRENCY = 'JPY';
const DAY_ROWS = 400;          // ~13 months of daily history; caps streak/history memory
const TRIP_CACHE_MS = 300000;    // a running trip won't change under us; keeps polling cheap
const NO_TRIP_CACHE_MS = 30000;  // but a trip created just now should start counting fast

// Namespaces beyond db:own can be missing on a host that predates them. The trek range
// makes that unlikely, but a build with a non-semver APP_VERSION skips the range check
// entirely — so every optional call goes through here as a thunk, which also catches the
// synchronous throw from reading a property off an undefined namespace.
async function attempt(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    return fallback;
  }
}

// SQLite has no ADD COLUMN IF NOT EXISTS, and migrate() only skips a step it has on
// record as applied. If that record is ever lost while the column survives — a restored
// backup, a half-applied run — the plain call throws and activation fails for good, so
// treat "the column is already there" as the success it is.
async function addColumn(ctx, id, sql) {
  try {
    await ctx.db.migrate(id, sql);
  } catch (err) {
    if (!/duplicate column name/i.test(String(err && err.message))) throw err;
    ctx.log.info('column already present', { migration: id });
  }
}

function json(status, data) {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  };
}

// A route with no logged-in user can't own a tally — mirror the host's 401 shape.
function requireUser(req) {
  if (!req.user || typeof req.user.id !== 'number') {
    return json(401, { error: 'auth required' });
  }
  return null;
}

function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

// The client sends the user's own calendar day (from trek:context.formats.timezone).
// It is user input, so anything that isn't a bare ISO date falls back to the UTC day.
function pickLocalDate(req) {
  const raw = (req.query && req.query.d) || (req.body && req.body.localDate);
  return typeof raw === 'string' && DATE_RE.test(raw) ? raw : utcToday();
}

function shiftDate(iso, days) {
  const parts = iso.split('-');
  const at = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return new Date(at + days * 86400000).toISOString().slice(0, 10);
}

function toInt(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

// ctx.db.tx keeps a write and the state read that follows it atomic, and collapses what
// used to be three round trips into one RPC call. Two result shapes are in circulation
// (a bare array, and { results: [...] }), so normalise before indexing; if tx is missing
// altogether, fall back to running the ops in order.
async function runOps(ctx, ops) {
  if (ctx.db && typeof ctx.db.tx === 'function') {
    const res = await ctx.db.tx(ops);
    const list = Array.isArray(res) ? res : (res && Array.isArray(res.results) ? res.results : []);
    return list;
  }
  const out = [];
  for (const op of ops) {
    const args = op.args || [];
    if (/^\s*select/i.test(op.sql)) out.push({ rows: await ctx.db.query(op.sql, ...args) });
    else out.push(await ctx.db.exec(op.sql, ...args));
  }
  return out;
}

function rowsAt(results, index) {
  const entry = results[index];
  return entry && Array.isArray(entry.rows) ? entry.rows : [];
}

// ---- user settings --------------------------------------------------------
// scope:'user' fields never reach ctx.config — they arrive one at a time through
// ctx.settings.get, and are undefined in a userless context.
async function readPrefs(ctx, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = await attempt(() => ctx.settings.get(key), undefined);
  }
  return out;
}

function priceOf(prefs) {
  const n = toInt(prefs.price_per_piece, DEFAULT_PRICE);
  return n > 0 && n <= 1000000 ? n : DEFAULT_PRICE;
}

function currencyOf(prefs) {
  const raw = typeof prefs.currency === 'string' ? prefs.currency.trim().toUpperCase() : '';
  return CURRENCY_RE.test(raw) ? raw : DEFAULT_CURRENCY;
}

function goalOf(prefs) {
  const n = toInt(prefs.daily_goal, 0);
  return n > 0 && n <= 99 ? n : 0;
}

function isOn(value, fallbackOn) {
  if (value === undefined || value === null || value === '') return fallbackOn;
  return String(value).toLowerCase() !== 'off';
}

// ---- trip resolution ------------------------------------------------------
// A dashboard sidebar widget only gets a tripId when a trip is spotlighted, so the trip a
// bite belongs to is derived from the date instead: the trip whose span covers today.
// Overlapping trips resolve to the one that started most recently.
const tripCache = new Map();

async function runningTrip(ctx, userId, localDate) {
  const key = userId + ':' + localDate;
  const hit = tripCache.get(key);
  if (hit) {
    // A "no trip" answer is cached far more briefly: a trip created moments ago should
    // start catching Famichiki quickly, whereas a running trip won't change under us.
    const ttl = hit.trip ? TRIP_CACHE_MS : NO_TRIP_CACHE_MS;
    if (hit.at > Date.now() - ttl) return hit.trip;
  }

  let trips;
  try {
    trips = await ctx.trips.listMine();
  } catch (err) {
    // A failed lookup is NOT "no trip is running". Caching it would stamp trip_id NULL onto
    // every Famichiki for the whole window, and nothing ever re-derives it — the bites would
    // be missing from the trip badge, the PDF and the budget permanently. Serve the previous
    // answer if there is one and retry on the next call instead.
    ctx.log.warn('trip lookup failed, not caching', { error: String(err && err.message) });
    return hit ? hit.trip : null;
  }

  let best = null;
  if (Array.isArray(trips)) {
    for (const trip of trips) {
      if (!trip || typeof trip.id !== 'number') continue;
      const start = typeof trip.start_date === 'string' ? trip.start_date.slice(0, 10) : null;
      const end = typeof trip.end_date === 'string' ? trip.end_date.slice(0, 10) : null;
      if (!start || !end || localDate < start || localDate > end) continue;
      if (!best || start > best.start) {
        best = { id: trip.id, title: typeof trip.title === 'string' ? trip.title : null, start };
      }
    }
  }
  tripCache.set(key, { trip: best, at: Date.now() });
  if (tripCache.size > 500) tripCache.clear();
  return best;
}

// ---- state ----------------------------------------------------------------
function streakFrom(days, localDate) {
  const seen = new Set(days.map((r) => r.d));
  // A day that hasn't been eaten on yet must not break a streak that is still alive.
  let cursor = seen.has(localDate) ? localDate : shiftDate(localDate, -1);
  let run = 0;
  while (seen.has(cursor)) {
    run += 1;
    cursor = shiftDate(cursor, -1);
  }
  return run;
}

function longestStreakFrom(days) {
  const sorted = days.map((r) => r.d).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of sorted) {
    run = prev && shiftDate(prev, 1) === day ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

const STATE_SQL =
  'SELECT COUNT(*) AS total, ' +
  "SUM(CASE WHEN local_date = ? THEN 1 ELSE 0 END) AS today, " +
  'MAX(eaten_at) AS last FROM bites WHERE user_id = ?';

const DAYS_SQL =
  'SELECT local_date AS d, COUNT(*) AS n FROM bites ' +
  'WHERE user_id = ? AND local_date IS NOT NULL ' +
  'GROUP BY local_date ORDER BY local_date DESC LIMIT ' + DAY_ROWS;

function stateOps(userId, localDate, tripId) {
  const ops = [
    { sql: STATE_SQL, args: [localDate, userId] },
    { sql: DAYS_SQL, args: [userId] },
  ];
  if (tripId) {
    ops.push({
      sql: 'SELECT COUNT(*) AS n FROM bites WHERE user_id = ? AND trip_id = ?',
      args: [userId, tripId],
    });
  }
  return ops;
}

function shapeState(results, offset, localDate, trip, prefs) {
  const agg = rowsAt(results, offset)[0] || {};
  const days = rowsAt(results, offset + 1).filter((r) => r && typeof r.d === 'string');
  const tripRow = trip ? rowsAt(results, offset + 2)[0] : null;
  const total = Number(agg.total) || 0;

  return {
    total,
    today: Number(agg.today) || 0,
    lastEatenAt: agg.last || null,
    streak: streakFrom(days, localDate),
    longestStreak: longestStreakFrom(days),
    bestDay: days.reduce((max, r) => Math.max(max, Number(r.n) || 0), 0),
    daysEaten: days.length,
    history: days.slice(0, 7).reverse().map((r) => ({ date: r.d, count: Number(r.n) || 0 })),
    goal: goalOf(prefs),
    price: priceOf(prefs),
    currency: currencyOf(prefs),
    spent: total * priceOf(prefs),
    trip: trip ? { id: trip.id, title: trip.title, count: Number(tripRow && tripRow.n) || 0 } : null,
  };
}

async function loadState(ctx, userId, localDate, prefs) {
  const trip = await runningTrip(ctx, userId, localDate);
  const results = await runOps(ctx, stateOps(userId, localDate, trip && trip.id));
  return shapeState(results, 0, localDate, trip, prefs);
}

// ---- side effects of eating ----------------------------------------------
// Milestones are recorded so an undo followed by a re-count can't fire the same one twice.
async function fireMilestone(ctx, userId, total) {
  if (!MILESTONES.includes(total)) return;
  const already = await ctx.db.query(
    'SELECT 1 AS hit FROM milestones WHERE user_id = ? AND value = ?', userId, total);
  if (already.length) return;
  await ctx.db.exec(
    'INSERT OR IGNORE INTO milestones (user_id, value, reached_at) VALUES (?, ?, ?)',
    userId, total, new Date().toISOString());

  // notify.send forces the recipient to the acting user, so this only works from a route.
  // No emoji: the host strips them from every plugin-supplied string it renders itself.
  await attempt(() => ctx.notify.send({
    title: 'Famichiki number ' + total,
    body: 'That is ' + total + ' Famichiki logged. Itadakimasu.',
    link: '/',
    scope: 'user',
    targetId: userId,
  }), null);
}

// Budget sync must not interleave with itself. Reading the link, calling costs.create and
// storing the new id are three awaits, so two taps from two devices could both find no link
// and both create an item — leaving a duplicate the plugin can never clean up again. The
// plugin runs as a single Node process, so chaining per day is enough to serialise it.
const budgetChain = new Map();

function serialise(key, fn) {
  const prev = budgetChain.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);            // run regardless of how the previous one ended
  const settled = run.then(noop, noop);     // the chain must never reject, or it wedges
  budgetChain.set(key, settled);
  settled.then(function () {
    // Drop the entry once nothing newer has queued behind it, so the map stays bounded.
    if (budgetChain.get(key) === settled) budgetChain.delete(key);
  });
  return run;
}

function noop() {}

// One budget item per day, not per snack — a fortnight of counting would otherwise leave
// fifty near-identical rows in the trip's budget. The day's item is created on the first
// Famichiki and rewritten on every one after it, so undo and reset stay in step too.
function syncBudget(ctx, userId, tripId, localDate, prefs) {
  return serialise(userId + ':' + tripId + ':' + localDate,
    function () { return syncBudgetLocked(ctx, userId, tripId, localDate, prefs); });
}

async function syncBudgetLocked(ctx, userId, tripId, localDate, prefs) {
  const counted = await ctx.db.query(
    'SELECT COUNT(*) AS n FROM bites WHERE user_id = ? AND trip_id = ? AND local_date = ?',
    userId, tripId, localDate);
  const count = Number(counted[0] && counted[0].n) || 0;

  const linked = await ctx.db.query(
    'SELECT item_id FROM budget_links WHERE user_id = ? AND trip_id = ? AND local_date = ?',
    userId, tripId, localDate);
  const itemId = linked[0] ? linked[0].item_id : null;

  const forget = () => ctx.db.exec(
    'DELETE FROM budget_links WHERE user_id = ? AND trip_id = ? AND local_date = ?',
    userId, tripId, localDate);

  if (count === 0) {
    // Undo took the day's last Famichiki back, so its item should go too — but keep the
    // link if the removal was refused, or the item is stranded in the trip's budget with
    // nothing left pointing at it.
    if (itemId) {
      const gone = await attempt(
        () => ctx.costs.delete(tripId, itemId).then(() => true), false);
      if (!gone) return 'failed';
      await forget();
    }
    return 'off';
  }

  // The amount key is total_price. `amount` is silently stripped and the item saves at 0.
  const input = {
    name: count > 1 ? 'Famichiki x' + count : 'Famichiki',
    total_price: priceOf(prefs) * count,
    currency: currencyOf(prefs),
    category: 'Food',
    expense_date: localDate,
  };

  if (itemId) {
    if (await attempt(() => ctx.costs.update(tripId, itemId, input), null)) return 'ok';
    // Someone deleted the item inside TREK — drop the stale link and book a fresh one.
    await forget();
  }

  const created = await attempt(() => ctx.costs.create(tripId, input), null);
  if (!created || typeof created.id !== 'number') return 'failed';
  await ctx.db.exec(
    'INSERT OR REPLACE INTO budget_links (user_id, trip_id, local_date, item_id) VALUES (?, ?, ?, ?)',
    userId, tripId, localDate, created.id);
  return 'ok';
}

// Reset wipes the tally, so the items it created have to go with it. Worked in pages,
// because each removal is an RPC call and the host throttles a plugin that floods the
// dispatch boundary.
//
// A link is forgotten ONLY once its item is actually gone. Deleting every link regardless
// would strand items in a shared trip's budget with nothing left that knows they came from
// here — costs.delete legitimately refuses when the Costs addon was switched off or the
// user lost budget-edit rights, and a link that survives lets a later reset finish the job.
async function clearBudget(ctx, userId) {
  let removed = 0;
  let stranded = 0;
  for (let page = 0; page < 10; page++) {
    const links = await ctx.db.query(
      'SELECT trip_id, local_date, item_id FROM budget_links WHERE user_id = ? ' +
      'ORDER BY trip_id, local_date LIMIT 20', userId);
    if (!links.length) break;

    let progressed = false;
    for (const link of links) {
      const gone = Number(link.item_id) > 0
        ? await attempt(() => ctx.costs.delete(link.trip_id, link.item_id).then(() => true), false)
        : true;                       // reservation that never became an item
      if (!gone) { stranded += 1; continue; }
      await ctx.db.exec(
        'DELETE FROM budget_links WHERE user_id = ? AND trip_id = ? AND local_date = ?',
        userId, link.trip_id, link.local_date);
      removed += 1;
      progressed = true;
    }
    // Nothing in this page could be removed, so the next page would be the same rows.
    if (!progressed) break;
  }
  if (stranded) {
    ctx.log.warn('budget items kept — could not remove them', { userId, stranded });
  }
  return removed;
}

module.exports = definePlugin({
  async onLoad(ctx) {
    try {
      await ctx.db.migrate('001_bites',
        'CREATE TABLE IF NOT EXISTS bites (' +
          'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
          'user_id INTEGER NOT NULL, ' +
          'eaten_at TEXT NOT NULL)');
      await ctx.db.migrate('002_bites_user_idx',
        'CREATE INDEX IF NOT EXISTS idx_bites_user ON bites (user_id)');
      // One statement per migration id — migrate(id, sql) takes a single statement.
      await addColumn(ctx, '003_bites_local_date',
        'ALTER TABLE bites ADD COLUMN local_date TEXT');
      await addColumn(ctx, '004_bites_trip',
        'ALTER TABLE bites ADD COLUMN trip_id INTEGER');
      // Rows counted before 2.0.0 only carry a UTC timestamp; their true local day is
      // unrecoverable, so approximate it with the UTC day rather than leaving them out
      // of every per-day figure.
      await ctx.db.migrate('005_bites_backfill_local_date',
        "UPDATE bites SET local_date = substr(eaten_at, 1, 10) WHERE local_date IS NULL");
      await ctx.db.migrate('006_bites_user_date_idx',
        'CREATE INDEX IF NOT EXISTS idx_bites_user_date ON bites (user_id, local_date)');
      await ctx.db.migrate('007_bites_trip_idx',
        'CREATE INDEX IF NOT EXISTS idx_bites_trip ON bites (trip_id)');
      await ctx.db.migrate('008_milestones',
        'CREATE TABLE IF NOT EXISTS milestones (' +
          'user_id INTEGER NOT NULL, ' +
          'value INTEGER NOT NULL, ' +
          'reached_at TEXT NOT NULL, ' +
          'PRIMARY KEY (user_id, value))');
      await ctx.db.migrate('009_budget_links',
        'CREATE TABLE IF NOT EXISTS budget_links (' +
          'user_id INTEGER NOT NULL, ' +
          'trip_id INTEGER NOT NULL, ' +
          'local_date TEXT NOT NULL, ' +
          'item_id INTEGER NOT NULL, ' +
          'PRIMARY KEY (user_id, trip_id, local_date))');
      ctx.log.info('Famichiki Counter loaded');
    } catch (err) {
      // A throw here fails activation and counts toward the 5-crashes-in-5-minutes
      // auto-disable, so surface the reason instead of taking the plugin down.
      ctx.log.error('migration failed', { error: String(err && err.message) });
      throw err;
    }
  },

  routes: [
    // Current tally for the logged-in user.
    { method: 'GET', path: '/state', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        try {
          const localDate = pickLocalDate(req);
          const prefs = await readPrefs(ctx, ['daily_goal', 'price_per_piece', 'currency']);
          return json(200, await loadState(ctx, req.user.id, localDate, prefs));
        } catch (err) {
          ctx.log.error('state failed', { error: String(err && err.message) });
          return json(500, { error: 'state unavailable' });
        }
      } },

    // Record one more Famichiki for the logged-in user.
    { method: 'POST', path: '/eat', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        try {
          const userId = req.user.id;
          const localDate = pickLocalDate(req);
          const prefs = await readPrefs(ctx, [
            'daily_goal', 'price_per_piece', 'currency', 'milestone_alerts', 'budget_logging']);
          const trip = await runningTrip(ctx, userId, localDate);
          const tripId = trip ? trip.id : null;

          const results = await runOps(ctx, [
            { sql: 'INSERT INTO bites (user_id, eaten_at, local_date, trip_id) VALUES (?, ?, ?, ?)',
              args: [userId, new Date().toISOString(), localDate, tripId] },
            ...stateOps(userId, localDate, tripId),
          ]);
          const state = shapeState(results, 1, localDate, trip, prefs);

          if (isOn(prefs.milestone_alerts, true)) {
            await attempt(() => fireMilestone(ctx, userId, state.total), null);
          }
          let budget = 'off';
          if (tripId && isOn(prefs.budget_logging, false)) {
            budget = await attempt(() => syncBudget(ctx, userId, tripId, localDate, prefs), 'failed');
          }

          ctx.log.info('nom — one Famichiki logged', { userId, tripId });
          return json(200, Object.assign({ budget }, state));
        } catch (err) {
          ctx.log.error('eat failed', { error: String(err && err.message) });
          return json(500, { error: 'could not log that one' });
        }
      } },

    // Take back the most recent one — a mis-tap shouldn't cost the whole tally.
    { method: 'POST', path: '/undo', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        try {
          const userId = req.user.id;
          const localDate = pickLocalDate(req);
          const prefs = await readPrefs(ctx, [
            'daily_goal', 'price_per_piece', 'currency', 'budget_logging']);
          const trip = await runningTrip(ctx, userId, localDate);
          const tripId = trip ? trip.id : null;

          // Undo removes the newest row, which may sit on an earlier day than the one the
          // client is showing — rebalance that day's budget item, not today's.
          const newest = await ctx.db.query(
            'SELECT local_date, trip_id FROM bites WHERE user_id = ? ORDER BY id DESC LIMIT 1',
            userId);
          const removed = newest[0] || null;

          const results = await runOps(ctx, [
            { sql: 'DELETE FROM bites WHERE id = ' +
                '(SELECT id FROM bites WHERE user_id = ? ORDER BY id DESC LIMIT 1)',
              args: [userId] },
            ...stateOps(userId, localDate, tripId),
          ]);

          let budget = 'off';
          if (removed && removed.trip_id && removed.local_date && isOn(prefs.budget_logging, false)) {
            budget = await attempt(
              () => syncBudget(ctx, userId, removed.trip_id, removed.local_date, prefs), 'failed');
          }
          return json(200, Object.assign({ budget }, shapeState(results, 1, localDate, trip, prefs)));
        } catch (err) {
          ctx.log.error('undo failed', { error: String(err && err.message) });
          return json(500, { error: 'could not undo' });
        }
      } },

    // Wipe the logged-in user's tally back to zero.
    { method: 'POST', path: '/reset', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        try {
          const userId = req.user.id;
          const localDate = pickLocalDate(req);
          const prefs = await readPrefs(ctx, [
            'daily_goal', 'price_per_piece', 'currency', 'budget_logging']);
          const trip = await runningTrip(ctx, userId, localDate);

          // Remove the budget items first — once the rows are gone their links are the
          // only record of what this plugin put in the trip's budget.
          if (isOn(prefs.budget_logging, false)) {
            await attempt(() => clearBudget(ctx, userId), 0);
          }

          const results = await runOps(ctx, [
            { sql: 'DELETE FROM bites WHERE user_id = ?', args: [userId] },
            { sql: 'DELETE FROM milestones WHERE user_id = ?', args: [userId] },
            ...stateOps(userId, localDate, trip && trip.id),
          ]);
          return json(200, shapeState(results, 2, localDate, trip, prefs));
        } catch (err) {
          ctx.log.error('reset failed', { error: String(err && err.message) });
          return json(500, { error: 'could not reset' });
        }
      } },
  ],

  hooks: {
    // A badge on each dashboard trip card. The hook ctx carries no acting-user id, so this
    // is deliberately the trip's total across everyone who counted on it — a shared tally
    // for a shared trip, not a personal one.
    tripCardProvider: {
      async getCards(tripIds, ctx) {
        const ids = (Array.isArray(tripIds) ? tripIds : [])
          .filter((n) => Number.isInteger(n)).slice(0, 100);
        if (!ids.length) return [];
        const rows = await ctx.db.query(
          'SELECT trip_id, COUNT(*) AS n FROM bites WHERE trip_id IN (' +
            ids.map(() => '?').join(',') + ') GROUP BY trip_id', ...ids);
        return rows
          .filter((r) => Number(r.n) > 0)
          .map((r) => ({
            tripId: r.trip_id,
            id: 'famichiki-total',
            label: 'Famichiki',
            value: String(r.n),
            icon: 'Drumstick',
            tone: 'success',
          }));
      },
    },

    // A section in the trip's PDF export. Text only — the host lays out and escapes it.
    pdfSectionProvider: {
      async getSections(tripId, ctx) {
        const rows = await ctx.db.query(
          'SELECT local_date AS d, COUNT(*) AS n FROM bites ' +
          'WHERE trip_id = ? AND local_date IS NOT NULL ' +
          'GROUP BY local_date ORDER BY local_date', tripId);
        if (!rows.length) return [];

        const total = rows.reduce((sum, r) => sum + (Number(r.n) || 0), 0);
        const best = rows.reduce((max, r) => Math.max(max, Number(r.n) || 0), 0);
        const table = rows.slice(0, 50).map((r) => [r.d, String(r.n)]);
        const paragraphs = [
          total + ' Famichiki were counted on this trip, across ' + rows.length +
            (rows.length === 1 ? ' day.' : ' days.'),
          'The busiest day accounted for ' + best +
            (best === 1 ? ' Famichiki.' : ' of them.'),
        ];
        if (rows.length > 50) {
          paragraphs.push('The table below lists the first 50 days.');
        }
        return [{ title: 'Famichiki', paragraphs, table: { headers: ['Date', 'Count'], rows: table } }];
      },
    },
  },

  // GDPR. Userless and retried by the host until it succeeds, so it stays idempotent
  // and touches nothing but this plugin's own database.
  async deleteUserData({ userId }, ctx) {
    // Own tables only. Budget items already live in the trip's own budget and belong to
    // the trip now; removing them would be a core write, which needs an acting user.
    await runOps(ctx, [
      { sql: 'DELETE FROM bites WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM milestones WHERE user_id = ?', args: [userId] },
      { sql: 'DELETE FROM budget_links WHERE user_id = ?', args: [userId] },
    ]);
    ctx.log.info('erased Famichiki data', { userId });
  },

  async exportUserData({ userId }, ctx) {
    const bites = await ctx.db.query(
      'SELECT eaten_at, local_date, trip_id FROM bites WHERE user_id = ? ORDER BY id', userId);
    const milestones = await ctx.db.query(
      'SELECT value, reached_at FROM milestones WHERE user_id = ? ORDER BY value', userId);
    return { famichikiEaten: bites.length, bites, milestones };
  },
});
