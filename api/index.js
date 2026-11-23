const express = require('express');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const db = require('../lib/db');

const env = process.env;
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// Stateless signed-cookie session (works on serverless).
app.use(cookieSession({
  name: 'sid',
  keys: [env.SESSION_SECRET || 'change-me'],
  maxAge: 30 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
}));

// Never cache anything by default
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ---------- helpers ----------
const isEligible = (roll) =>
  /^107124\d{3}$/.test(roll) && parseInt(roll[roll.length - 1], 10) % 2 === 1;

const votingState = () => {
  const now = Date.now();
  if (env.VOTING_START && now < Date.parse(env.VOTING_START)) return 'not_started';
  if (env.VOTING_END && now > Date.parse(env.VOTING_END)) return 'ended';
  return 'open';
};

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------- DAuth ----------
app.get('/dlogin', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const params = new URLSearchParams({
    client_id: env.DAUTH_CLIENT_ID,
    redirect_uri: env.DAUTH_CALLBACK_URL,
    response_type: 'code',
    scope: env.DAUTH_SCOPE || 'openid email profile user',
    access_type: 'offline',
    state,
  });
  res.redirect(`${env.DAUTH_AUTHORIZE_URL}?${params}`);
});

app.get('/auth/delta/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== (req.session && req.session.oauthState)) {
      return res.redirect('/?error=state');
    }

    // 1. exchange code for access token
    const tokenRes = await fetch(env.DAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.DAUTH_CLIENT_ID,
        client_secret: env.DAUTH_CLIENT_SECRET,
        redirect_uri: env.DAUTH_CALLBACK_URL,
        grant_type: 'authorization_code',
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!token.access_token) return res.redirect('/?error=token');

    // 2. fetch user info (POST with empty body, as in your template)
    const uiRes = await fetch(env.DAUTH_USERINFO_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const user = await uiRes.json();

    // 3. extract roll no from e.g. 107124xxx@nitt.edu
    const raw = String(user[env.DAUTH_ROLL_FIELD || 'email'] || '');
    const roll = raw.split('@')[0].trim();
    const name = user.name || user.fullName || roll;

    if (!isEligible(roll)) {
      req.session = null;
      return res.redirect('/?error=ineligible');
    }

    // 4. fresh session holding identity only (never the vote)
    req.session = {
      user: { roll, name },
      csrf: crypto.randomBytes(16).toString('hex'),
    };
    res.redirect('/');
  } catch (e) {
    res.redirect('/?error=auth');
  }
});

app.post('/auth/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// ---------- voting API ----------
app.get('/api/me', async (req, res) => {
  try {
    const u = req.session && req.session.user;
    if (!u) return res.json({ loggedIn: false, state: votingState() });
    res.json({
      loggedIn: true,
      roll: u.roll,
      name: u.name,
      hasVoted: await db.hasVoted(u.roll),
      state: votingState(),
      csrf: req.session.csrf,
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/candidates', async (req, res) => {
  try {
    if (!(req.session && req.session.user)) return res.status(401).json({ error: 'Login required' });
    res.json(shuffle(await db.getCandidates())); // random order avoids position bias
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/vote', async (req, res) => {
  const u = req.session && req.session.user;
  if (!u) return res.status(401).json({ error: 'Login required' });
  if (req.get('x-csrf-token') !== req.session.csrf) return res.status(403).json({ error: 'Bad token' });
  if (votingState() !== 'open') return res.status(403).json({ error: 'Voting is not open' });
  if (!isEligible(u.roll)) return res.status(403).json({ error: 'Not eligible' });

  try {
    const candidateId = Number(req.body.candidateId);
    const cands = await db.getCandidates();
    if (!cands.some((c) => c.id === candidateId)) {
      return res.status(400).json({ error: 'Invalid candidate' });
    }

    await db.castVote(u.roll, u.name, candidateId);
    req.session = null; // vote done: clear the session
    res.json({ ok: true });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ error: 'You have already voted' });
    }
    res.status(500).json({ error: 'Could not record vote' });
  }
});

// ---------- results API ----------
// The Vercel edge caches this for N seconds, so votes are batched into snapshots.
app.get('/api/results', async (req, res) => {
  try {
    const ttl = Number(env.RESULTS_REFRESH_SECONDS || 30);
    const data = await db.getResults();
    res.set('Cache-Control', `public, max-age=0, s-maxage=${ttl}`);
    res.json({ ...data, updatedAt: new Date().toISOString(), state: votingState() });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = app;