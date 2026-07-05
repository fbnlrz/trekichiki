// Famichiki Counter — built plugin entry, runs in an isolated child process.
// Stores one row per Famichiki eaten, per user, in the plugin's own SQLite file.
const { definePlugin } = require('trek-plugin-sdk');

// Build the current tally for a single user from the bites log.
async function readState(ctx, userId) {
  const totalRows = await ctx.db.query(
    'SELECT COUNT(*) AS n FROM bites WHERE user_id = ?', userId);
  const todayRows = await ctx.db.query(
    "SELECT COUNT(*) AS n FROM bites WHERE user_id = ? AND date(eaten_at) = date('now')", userId);
  const lastRows = await ctx.db.query(
    'SELECT MAX(eaten_at) AS last FROM bites WHERE user_id = ?', userId);

  return {
    total: (totalRows[0] && totalRows[0].n) || 0,
    today: (todayRows[0] && todayRows[0].n) || 0,
    lastEatenAt: (lastRows[0] && lastRows[0].last) || null,
  };
}

// A route with no logged-in user can't own a tally — mirror the host's 401 shape.
function requireUser(req) {
  if (!req.user || typeof req.user.id !== 'number') {
    return { status: 401, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'auth required' }) };
  }
  return null;
}

function json(status, data) {
  return { status, headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data) };
}

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_bites',
      'CREATE TABLE IF NOT EXISTS bites (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT, ' +
        'user_id INTEGER NOT NULL, ' +
        'eaten_at TEXT NOT NULL)');
    await ctx.db.migrate('002_bites_user_idx',
      'CREATE INDEX IF NOT EXISTS idx_bites_user ON bites (user_id)');
    ctx.log.info('Famichiki Counter loaded');
  },

  routes: [
    // Current tally for the logged-in user.
    { method: 'GET', path: '/state', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        return json(200, await readState(ctx, req.user.id));
      } },

    // Record one more Famichiki for the logged-in user.
    { method: 'POST', path: '/eat', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        await ctx.db.exec(
          'INSERT INTO bites (user_id, eaten_at) VALUES (?, ?)',
          req.user.id, new Date().toISOString());
        ctx.log.info('nom — one Famichiki logged', { userId: req.user.id });
        return json(200, await readState(ctx, req.user.id));
      } },

    // Wipe the logged-in user's tally back to zero.
    { method: 'POST', path: '/reset', auth: true,
      async handler(req, ctx) {
        const denied = requireUser(req);
        if (denied) return denied;
        await ctx.db.exec('DELETE FROM bites WHERE user_id = ?', req.user.id);
        return json(200, await readState(ctx, req.user.id));
      } },
  ],
});
