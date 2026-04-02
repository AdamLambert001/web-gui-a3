require('dotenv').config();

const fs = require('fs');
const path = require('path');
const util = require('util');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const session = require('express-session');

const app = express();
const PORT = Number(process.env.PORT || 3000);

// Environment configuration
const ARMA3_PATH = process.env.ARMA3_PATH;
const ARMA3_MISSION_PATH = process.env.ARMA3_MISSION_PATH;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI =
  process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';
// IIS/ARR often rewrites 302 Location headers and breaks https://discord.com/... redirects.
// HTML+JS redirect avoids that. Set DISCORD_OAUTH_HTML_REDIRECT=false to use a plain 302 instead.
const DISCORD_OAUTH_HTML_REDIRECT =
  process.env.DISCORD_OAUTH_HTML_REDIRECT !== 'false' &&
  process.env.DISCORD_OAUTH_HTML_REDIRECT !== '0';
const DISCORD_ROLES_FILE =
  process.env.DISCORD_ROLES_FILE || path.join(__dirname, 'discord-roles.json');

const AUDIT_LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(AUDIT_LOG_DIR)) {
  try {
    fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
  } catch (err) {
    console.error('Failed to create audit log directory', err);
  }
}

const auditSessionStamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace('T', '_')
  .slice(0, 19);
const AUDIT_LOG_FILE = path.join(AUDIT_LOG_DIR, `audit-${auditSessionStamp}.log`);

if (!ARMA3_PATH) {
  console.warn(
    'ARMA3_PATH is not set in .env – server commands may need manual paths.'
  );
}

if (!ARMA3_MISSION_PATH) {
  console.warn(
    'ARMA3_MISSION_PATH is not set in .env – mission file API will be disabled.'
  );
}

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.set('trust proxy', 1);

// Lightweight probe for IIS/load balancers (no session, no auth).
app.get('/healthz', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).type('text/plain').send('ok');
});

function safeErrorText(err) {
  if (!err) return 'Unknown error';
  if (err instanceof Error && err.stack) return err.stack;
  return util.inspect(err);
}

function logFatal(label, err) {
  console.error(`[${label}] ${safeErrorText(err)}`);
}

process.on('unhandledRejection', (reason) => {
  logFatal('UNHANDLED_REJECTION', reason);
});

process.on('uncaughtException', (err) => {
  logFatal('UNCAUGHT_EXCEPTION', err);
});

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 10 * 60 * 1000, // 10 minutes of inactivity
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true'
    },
    rolling: true // reset expiry on each request
  })
);

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  if (req.path && req.path.startsWith('/api/')) {
    return res.status(401).json({
      ok: false,
      message: 'Not authenticated – please reload and log in again.'
    });
  }

  return res.redirect('/login');
}

function getSessionRoles(req) {
  if (req.session && req.session.roles && typeof req.session.roles === 'object') {
    return req.session.roles;
  }
  return { canUpload: false, canControlServers: false };
}

/** Discord CDN URL for avatar (custom or default). */
function discordAvatarUrl(discordId, avatarHash, discriminator) {
  if (avatarHash) {
    const ext = String(avatarHash).startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.${ext}?size=64`;
  }
  const disc = Number(discriminator);
  const index = Number.isFinite(disc) ? Math.abs(disc) % 5 : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

function requireRole(roleKey) {
  return function roleMiddleware(req, res, next) {
    if (!req.session || !req.session.authenticated) {
      if (req.path && req.path.startsWith('/api/')) {
        return res.status(401).json({
          ok: false,
          message: 'Not authenticated – please reload and log in again.'
        });
      }
      return res.redirect('/login');
    }

    const roles = getSessionRoles(req);
    if (roles[roleKey]) {
      return next();
    }

    if (req.path && req.path.startsWith('/api/')) {
      return res.status(403).json({
        ok: false,
        message: 'You do not have permission to perform this action.'
      });
    }

    return res.status(403).send('Forbidden');
  };
}

const requireServerControl = requireRole('canControlServers');
const requireFileUpload = requireRole('canUpload');

// Optional: root folder where you keep per-server profiles/configs.
// Adjust or replace if your layout is different.
const ARMA3_SERVERS_ROOT = ARMA3_PATH
  ? path.join(ARMA3_PATH, 'Servers')
  : 'G:\\Arma\\Servers';

// Path for persisted server definitions
const SERVERS_CONFIG_FILE = path.join(__dirname, 'servers.json');

// Path for persisted operation/mission definitions
const OPS_CONFIG_FILE = path.join(__dirname, 'ops.json');

// Static terrain conditions for all operations (as requested)
const TERRAIN_CONDITIONS = {
  environmentalElements: 'Clear with fog',
  timeOfDay: '8 AM local time',
  terrain: 'Thick forests',
  localsPresence: 'In active hiding',
  planopsLink: 'Link compromised',
  operationTimeTable: [
    {
      label: 'Leadership Load in:',
      bstTime: '18:30 BST',
      estTime: '13:30 EST'
    },
    {
      label: 'General Load in:',
      bstTime: '19:00 BST',
      estTime: '14:00 EST'
    },
    {
      label: 'Step Off:',
      bstTime: '19:30 BST',
      estTime: '14:30 EST'
    },
    {
      label: 'Soft Cut off:',
      bstTime: '21:30 BST',
      estTime: '16:30 EST'
    },
    {
      label: 'Hard Cut off:',
      bstTime: '22:00 BST',
      estTime: '17:00 EST'
    }
  ]
};

const DEFAULT_OP_META = {
  date: '08/03/2550',
  planet: 'Meridian',
  sector: 'Eastern coast',
  opposingforce: 'Covenant'
};

function normalizeFriendlyName(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlWithNewlines(str) {
  return escapeHtml(String(str || '')).replace(/\r?\n/g, '<br/>');
}

function writeJsonAtomicSync(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

let opsCache = [];
let opsCacheLoaded = false;
let opsLastMtimeMs = 0;

function getOpsConfigMtimeMs() {
  try {
    const stat = fs.statSync(OPS_CONFIG_FILE);
    return stat.mtimeMs;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      console.error('Failed to stat ops.json', err);
    }
    return 0;
  }
}

function loadOps() {
  try {
    if (!fs.existsSync(OPS_CONFIG_FILE)) {
      opsCache = [];
      opsCacheLoaded = true;
      opsLastMtimeMs = 0;
      return opsCache;
    }
    const raw = fs.readFileSync(OPS_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      opsCache = parsed;
      opsCacheLoaded = true;
      opsLastMtimeMs = getOpsConfigMtimeMs();
      return opsCache;
    }
    console.warn('ops.json exists but is not an array; ignoring.');
    opsCache = [];
    opsCacheLoaded = true;
    opsLastMtimeMs = getOpsConfigMtimeMs();
    return opsCache;
  } catch (err) {
    console.error('Failed to load ops.json; using empty list.', err);
    opsCache = [];
    opsCacheLoaded = true;
    return opsCache;
  }
}

function saveOps(ops) {
  try {
    writeJsonAtomicSync(OPS_CONFIG_FILE, ops);
    opsCache = Array.isArray(ops) ? ops : [];
    opsCacheLoaded = true;
    opsLastMtimeMs = getOpsConfigMtimeMs();
  } catch (err) {
    console.error('Failed to save ops.json', err);
  }
}

function getOps() {
  const currentMtime = getOpsConfigMtimeMs();
  if (!opsCacheLoaded || currentMtime !== opsLastMtimeMs) {
    return loadOps();
  }
  return opsCache;
}

function getOpByFriendlyName(friendlyName) {
  const normalized = normalizeFriendlyName(friendlyName);
  const ops = getOps();
  return ops.find((o) => normalizeFriendlyName(o.opfreindlyname) === normalized) || null;
}

function renderOpsViewHtml(operation) {
  const optionalObjectives = Array.isArray(operation.optionalobjectives)
    ? operation.optionalobjectives.filter((x) => String(x || '').trim().length > 0)
    : [];

  const optionalObjectivesHtml = optionalObjectives.length
    ? optionalObjectives.map((o) => `&bull; ${escapeHtml(o)}`).join('<br/>')
    : '<span style="color:#8abf9b;">None</span>';

  const tc = operation.terrainConditions || TERRAIN_CONDITIONS;

  const timeRowsHtml = Array.isArray(tc.operationTimeTable) ? tc.operationTimeTable : [];
  const timeTableHtml = timeRowsHtml.length
    ? `<table class="time-table">
${timeRowsHtml
  .map(
    (row) => `<tr>
      <td class="time-label">${escapeHtml(row.label)}</td>
      <td class="time-value">${escapeHtml(row.bstTime)} / ${escapeHtml(row.estTime)}</td>
    </tr>`
  )
  .join('')}
</table>`
    : '<div style="color:#8abf9b;">No time table</div>';

  // Static header (matching the examples you provided)
  const meta = {
    Date: '08/03/2550',
    Planet: 'Meridian',
    Sector: 'Eastern coast',
    'Opposing force': 'Covenant'
  };

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(operation.Operationtitle)} - Ops</title>
    <style>
      body {
        margin: 0;
        padding: 0;
        background: #000000;
        color: #c9d5cc;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono',
          'Courier New', monospace;
      }

      .page {
        max-width: 980px;
        margin: 0 auto;
        padding: 18px 14px 40px;
      }

      .op-title {
        text-align: center;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        font-size: 22px;
        margin: 10px 0 18px;
      }

      .panel {
        background: #070707;
        border: 1px solid #12321f;
        border-radius: 10px;
        padding: 14px 14px 10px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.7);
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        border: 2px solid #050505;
        padding: 10px 12px;
        font-size: 14px;
        line-height: 1.35;
        vertical-align: top;
      }

      th {
        background: #a6a6a6;
        color: #07140e;
        font-weight: 700;
        width: 34%;
        text-align: left;
      }

      td {
        background: #0c0c0c;
        color: #c9d5cc;
      }

      .mission-statement-title {
        margin-top: 18px;
        font-size: 18px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: #c9d5cc;
      }

      .mission-statement {
        margin-top: 8px;
        padding: 12px 12px;
        border-radius: 10px;
        background: rgba(77,189,107,0.10);
        border: 1px solid rgba(77,189,107,0.28);
        color: #e7f5ea;
        white-space: normal;
      }

      .section {
        margin-top: 16px;
      }

      .section h2 {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 800;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #c9d5cc;
      }

      .objective-table th { width: 42%; }
      .terrain-table th { width: 40%; }

      .time-table {
        width: 100%;
        border-collapse: collapse;
      }

      .time-table td,
      .time-table th {
        border-width: 2px;
        padding: 8px 10px;
      }

      .time-label {
        width: 52%;
        font-weight: 700;
      }

      .time-value {
        width: 48%;
      }

      .footer-links {
        margin-top: 18px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }

      .footer-links a {
        color: #4dbd6b;
        text-decoration: none;
        border: 1px solid rgba(77,189,107,0.35);
        background: rgba(77,189,107,0.08);
        padding: 8px 10px;
        border-radius: 8px;
      }

      .footer-links a:hover {
        background: rgba(77,189,107,0.14);
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="op-title">${escapeHtml(operation.Operationtitle)}</div>

      <div class="panel">
        <table>
          <tr><th colspan="2" style="background:#a6a6a6;color:#07140e;text-align:center;">Operation Stockpile</th></tr>
          <tr><th>Date</th><td>${escapeHtml(meta.Date)}</td></tr>
          <tr><th>Planet</th><td>${escapeHtml(meta.Planet)}</td></tr>
          <tr><th>Sector</th><td>${escapeHtml(meta.Sector)}</td></tr>
          <tr><th>Opposing force</th><td>${escapeHtml(meta['Opposing force'])}</td></tr>
        </table>

        <div class="section">
          <div class="mission-statement-title">Mission statement</div>
          <div class="mission-statement">${escapeHtmlWithNewlines(operation.missionstatement)}</div>
        </div>

        <div class="section">
          <h2>Operation description</h2>
          <div class="mission-statement" style="margin-top:0;">${escapeHtmlWithNewlines(operation.opdescription)}</div>
        </div>

        <div class="section">
          <h2>Main objectives</h2>
          <table class="objective-table">
            <tr><th>Main Objectives</th><td>${escapeHtmlWithNewlines(operation.mainobjective)}</td></tr>
            <tr><th>Secondary Objective</th><td>${escapeHtmlWithNewlines(operation.secondaryobjective)}</td></tr>
            <tr><th>Optional Objectives</th><td>${optionalObjectivesHtml}</td></tr>
          </table>
        </div>

        <div class="section">
          <h2>Battle conditions</h2>
          <table class="terrain-table">
            <tr><th>Environmental Elements</th><td>${escapeHtml(tc.environmentalElements)}</td></tr>
            <tr><th>Time of day</th><td>${escapeHtml(tc.timeOfDay)}</td></tr>
            <tr><th>Terrain</th><td>${escapeHtml(tc.terrain)}</td></tr>
            <tr><th>Locals Presence</th><td>${escapeHtml(tc.localsPresence)}</td></tr>
            <tr><th>Planops link</th><td>${escapeHtml(tc.planopsLink)}</td></tr>
            <tr>
              <th>Operation Time Table</th>
              <td>${timeTableHtml}</td>
            </tr>
          </table>
        </div>

        <div class="footer-links">
          <a href="/">Back to admin</a>
          <div style="color:#94a3b8;font-size:12px;">
            URL: /ops/${escapeHtml(operation.opfreindlyname)}
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

// In-memory log buffer and SSE for web console
const MAX_LOG_LINES = 500;
const logBuffer = [];
const sseClients = new Set();

function writeAuditEntry(entry) {
  const payload = {
    ts: new Date().toISOString(),
    ...entry
  };
  const line = JSON.stringify(payload);
  fs.appendFile(AUDIT_LOG_FILE, line + '\n', (err) => {
    if (err) {
      // Best-effort logging; do not crash on failure
      console.error('Failed to write audit log entry', err);
    }
  });
}

function audit(req, action, details) {
  const session = req.session || {};
  writeAuditEntry({
    action,
    details,
    username: session.username || null,
    discordId: session.discordId || null,
    authProvider: session.authProvider || null
  });
}

let discordRoles = [];

function loadDiscordRoles() {
  try {
    if (!fs.existsSync(DISCORD_ROLES_FILE)) {
      console.warn(
        `Discord roles file '${DISCORD_ROLES_FILE}' not found – Discord users will have no special permissions.`
      );
      return [];
    }

    const raw = fs.readFileSync(DISCORD_ROLES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    console.warn(
      `Discord roles file '${DISCORD_ROLES_FILE}' is not an array – ignoring and using empty roles.`
    );
  } catch (err) {
    console.error('Error reading Discord roles configuration, using empty roles.', err);
  }
  return [];
}

function resolveDiscordRoles(discordId) {
  const entry = discordRoles.find((r) => String(r.discordId) === String(discordId));
  if (!entry) {
    return { canUpload: false, canControlServers: false };
  }
  return {
    canUpload: Boolean(entry.canUpload),
    canControlServers: Boolean(entry.canControlServers)
  };
}

function broadcastLog(level, message) {
  const text = typeof message === 'string' ? message : util.inspect(message);
  const line = { level, message: text.trimEnd(), ts: new Date().toISOString() };
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
  sseClients.forEach((res) => {
    try {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    } catch (_) {
      sseClients.delete(res);
    }
  });
}

const _consoleLog = console.log;
const _consoleError = console.error;
const _consoleWarn = console.warn;
console.log = (...args) => {
  _consoleLog.apply(console, args);
  broadcastLog('log', util.format(...args));
};
console.error = (...args) => {
  _consoleError.apply(console, args);
  broadcastLog('error', util.format(...args));
};
console.warn = (...args) => {
  _consoleWarn.apply(console, args);
  broadcastLog('warn', util.format(...args));
};

function loadServers() {
  try {
    const raw = fs.readFileSync(SERVERS_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    console.warn('servers.json is not an array; using default configuration.');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Error reading servers.json, using defaults instead.', err);
    }
  }

  // Default configuration if no file exists or is invalid
  return [
    {
      id: 'server1',
      name: 'Arma 3 Server 1',
      port: 2302,
      profileId: '_11c5c3e7231e4816af4cc9adba2048a2',
      mods:
        '@3den_Enhanced;@CBA_A3;@Operation_TREBUCHET;@ace;@Zeus_Enhanced;@UNSC_Foundries;@Remove_stamina;@Misriah_Armory;@Improved_Melee_System;@Operation_TREBUCHET_First_Contact;@ACE3_Arsenal_Extended__Core;@Operation_Trebuchet_PLUS_;@Task_Force_Arrowhead_Radio_BETA__;@ACE_3_Extension_Animations_and_Actions_;@ACE_3_Extension_Gestures_;@ACE_Interaction_Menu_Expansion;@Alternative_Running;@CH_View_Distance;@Crows_Zeus_Additions;@CUP_Terrains__Core;@DUI__Squad_Radar;@Eden_Extended_Objects;@Eden_Objects;@EnhancedTrenches;@Fire_Support_Plus;@Global_Ops_Terrains;@Halo_Map_Markers;@Halo_Music_Collection;@Jbad;@No_More_Aircraft_Bouncing;@No_Weapon_Sway;@Remove_stamina__ACE_3;@Sci_fi_Support_Plus;@UNSC_Foundries_Ace_Compat;@Weather_Plus;@WMO__Walkable_Moving_Objects;@ZEI__Zeus_and_Eden_Interiors;@cTab;@Crows_Electronic_Warfare;@The_Cole_Protocol;@41st_ODST_MFR__Declassified_Assets;@JM_s_Structures;@KJW_s_Two_Primary_Weapons;@Watershed_Division;@Scifi_Vehicles_Pack;@Helmet_on_Ass__Helmet_Slinging;@KAT__Advanced_Medical;@Task_Force_Timberwolf_Female_Characters;@Misriah_Armory_Project_ORION;@3den_Edit_Freefall_Modules;@Enhanced_Movement;@Dismount_Loop__Run_Over_Prevention_System;@Incoming_Transmission;@Incoming_Transmission__Pings;@Zulu_Headless_Client_ZHC_;@Archie_Summer;@Maksniemi;@Stubbhult;@Drakovac;@WebKnight_s_OPTRE_Expansion;@White_Team_Aux;@UNSC_Naval_Special_Weapons;@Freefall_Fix;@Zeus_Enhanced_Targeting_ZET___v1_2_Custom_Filters_;@_C21_Jiralhanae_WIP;@UNSC_Infirmary;',
      serverMods: '@Zulu_Headless_Client_ZHC_;',
      extraArgs: '-enableHT -autoInit',
      configPath: '',
      basicConfigPath: '',
      profilesPath: '',
      serverPassword: ''
    }
  ];
}

function saveServers(servers) {
  try {
    writeJsonAtomicSync(SERVERS_CONFIG_FILE, servers);
  } catch (err) {
    console.error('Failed to write servers.json', err);
  }
}

let servers = loadServers();

discordRoles = loadDiscordRoles();

// Public favicon for unauthenticated pages (like /login)
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

// Authentication routes
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Local admin login disabled: all authentication must go through Discord.
app.post('/login', (req, res) => {
  return res
    .status(410)
    .send('Local username/password login has been disabled. Please use Discord login.');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

function redirectToDiscordAuthorize(res, authorizeUrl) {
  if (!DISCORD_OAUTH_HTML_REDIRECT) {
    return res.redirect(302, authorizeUrl);
  }
  const safe = JSON.stringify(authorizeUrl);
  return res
    .status(200)
    .type('html')
    .send(
      '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Discord</title></head><body>' +
        `<script>location.replace(${safe});</script><p>Redirecting to Discord…</p></body></html>`
    );
}

app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res
      .status(500)
      .send(
        'Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in your .env file.'
      );
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify'
  });

  const authorizeUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  return redirectToDiscordAuthorize(res, authorizeUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('Missing authorization code from Discord.');
  }

  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
    return res
      .status(500)
      .send(
        'Discord OAuth is not configured. Set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET in your .env file.'
      );
  }

  try {
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });

    if (!tokenResponse.ok) {
      console.error('Failed to exchange Discord code for token', await tokenResponse.text());
      return res.status(500).send('Failed to authenticate with Discord.');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const userResponse = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });

    if (!userResponse.ok) {
      console.error('Failed to fetch Discord user info', await userResponse.text());
      return res.status(500).send('Failed to fetch Discord user information.');
    }

    const user = await userResponse.json();
    const discordId = user.id;
    const username = user.global_name || `${user.username}#${user.discriminator}`;

    const roles = resolveDiscordRoles(discordId);

    req.session.regenerate((err) => {
      if (err) {
        console.error('Failed to regenerate session on Discord login', err);
        return res
          .status(500)
          .send('Discord login failed due to a server error. Please try again.');
      }

      req.session.authenticated = true;
      req.session.username = username;
      req.session.discordId = discordId;
      req.session.discordAvatar = user.avatar || null;
      req.session.discordDiscriminator = user.discriminator;
      req.session.authProvider = 'discord';
      req.session.roles = roles;

      res.redirect('/');
    });
  } catch (err) {
    console.error('Discord OAuth callback error', err);
    res.status(500).send('Discord authentication failed.');
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  const roles = getSessionRoles(req);
  let avatarUrl = null;
  if (req.session.authProvider === 'discord' && req.session.discordId) {
    avatarUrl = discordAvatarUrl(
      req.session.discordId,
      req.session.discordAvatar,
      req.session.discordDiscriminator
    );
  }
  res.json({
    ok: true,
    username: req.session.username || null,
    authProvider: req.session.authProvider || null,
    discordId: req.session.discordId || null,
    avatarUrl,
    roles
  });
});

function buildServerCommand(server) {
  const exe = ARMA3_PATH
    ? path.join(ARMA3_PATH, 'arma3server_x64.exe')
    : 'arma3server_x64.exe';

  const { profileRoot, configPath, basicPath } = resolveServerPaths(server);

  const args = [
    `-port=${server.port}`,
    `-config=${configPath}`,
    `-cfg=${basicPath}`,
    `-profiles=${profileRoot}`,
    `-name=${server.profileId}`
  ];

  if (server.mods) {
    args.push(`-mod=${server.mods}`);
  }

  if (server.serverMods) {
    args.push(`-serverMod=${server.serverMods}`);
  }

  if (server.extraArgs) {
    args.push(
      ...server.extraArgs
        .split(' ')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  return { exe, args };
}

function buildHeadlessClientCommand(server) {
  const exe = ARMA3_PATH
    ? path.join(ARMA3_PATH, 'arma3server_x64.exe')
    : 'arma3server_x64.exe';

  const profileRoot =
    server.profilesPath && server.profilesPath.trim().length > 0
      ? server.profilesPath
      : path.join(ARMA3_SERVERS_ROOT, server.profileId);

  const hcProfilePath = profileRoot + '_hc1';

  const args = [
    '-client',
    '-connect=127.0.0.1',
    `-profiles=${hcProfilePath}`,
    '-nosound',
    `-port=${server.port}`,
    '-enableHT'
  ];

  if (server.serverPassword && String(server.serverPassword).trim()) {
    args.push(`-password=${server.serverPassword.trim()}`);
  }

  if (server.mods) {
    args.push(`-mod=${server.mods}`);
  }

  return { exe, args };
}

// Track running processes by server ID
const running = new Map();

// Track headless client PIDs by server ID (so we can kill them when server stops)
const runningHeadlessClients = new Map();

function getServerDisplayLabel(serverId) {
  const server = servers.find((s) => s.id === serverId);
  if (!server) return serverId;
  return server.name || server.id;
}

function resolveServerPaths(server) {
  const profileRoot =
    server.profilesPath && server.profilesPath.trim().length > 0
      ? server.profilesPath
      : path.join(ARMA3_SERVERS_ROOT, server.profileId);

  const configPath =
    server.configPath && server.configPath.trim().length > 0
      ? server.configPath
      : path.join(profileRoot, 'server_config.cfg');

  const basicPath =
    server.basicConfigPath && server.basicConfigPath.trim().length > 0
      ? server.basicConfigPath
      : path.join(profileRoot, 'server_basic.cfg');

  return { profileRoot, configPath, basicPath };
}

function missionTemplateFromFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return '';
  if (fileName.toLowerCase().endsWith('.pbo')) {
    return fileName.slice(0, -4);
  }
  return fileName;
}

function getStatus(id) {
  const info = running.get(id);
  return info ? info.status : 'stopped';
}

function spawnTaskkill(pid, label) {
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
  killer.on('error', (err) => {
    console.error(`taskkill failed for ${label} (PID ${pid})`, err);
  });
  return killer;
}

function startServer(id) {
  if (running.has(id)) {
    return { ok: false, message: 'Server already running' };
  }

  const server = servers.find((s) => s.id === id);
  if (!server) {
    return { ok: false, message: 'Unknown server ID' };
  }

  const { exe, args } = buildServerCommand(server);
  console.log(`Starting server ${id} with command: ${exe} ${args.join(' ')}`);

  const child = spawn(exe, args, {
    cwd: ARMA3_PATH || undefined,
    detached: false
  });

  const startedAt = new Date();
  const info = {
    process: child,
    status: 'running',
    startedAt
  };

  running.set(id, info);

  child.stdout.on('data', (data) => {
    console.log(`[${id}] ${data}`);
    info.status = 'running';
  });

  child.stderr.on('data', (data) => {
    console.error(`[${id} ERROR] ${data}`);
  });

  child.on('error', (err) => {
    console.error(`Server ${id} failed to start`, err);
    running.delete(id);
  });

  child.on('exit', (code, signal) => {
    console.log(`Server ${id} exited with code ${code}, signal ${signal}`);
    // Kill any headless clients that were started for this server
    const hcPids = runningHeadlessClients.get(id);
    if (hcPids && hcPids.length > 0) {
      console.log(`Stopping ${hcPids.length} headless client(s) for ${id}`);
      for (const hcPid of hcPids) {
        spawnTaskkill(hcPid, `${id} headless client`);
      }
      runningHeadlessClients.delete(id);
    }
    running.delete(id);
  });

  return { ok: true, message: 'Start command issued' };
}

function stopServer(id) {
  const info = running.get(id);
  if (!info) {
    return { ok: false, message: 'Server not running' };
  }

  const pid = info.process.pid;
  console.log(`Stopping server ${id}, PID ${pid}`);

  // On Windows, use taskkill to stop the process tree.
  const killer = spawnTaskkill(pid, id);

  killer.on('exit', (code) => {
    console.log(`taskkill for ${id} exited with code ${code}`);
  });

  // Kill any headless clients that were started for this server
  const hcPids = runningHeadlessClients.get(id);
  if (hcPids && hcPids.length > 0) {
    console.log(`Stopping ${hcPids.length} headless client(s) for ${id}: PIDs ${hcPids.join(', ')}`);
    for (const hcPid of hcPids) {
      spawnTaskkill(hcPid, `${id} headless client`);
    }
    runningHeadlessClients.delete(id);
  }

  running.delete(id);
  return { ok: true, message: 'Stop command issued' };
}

function startHeadlessClient(id) {
  const server = servers.find((s) => s.id === id);
  if (!server) {
    return { ok: false, message: 'Unknown server ID' };
  }

  if (!running.has(id)) {
    return { ok: false, message: 'Server must be running to add a headless client' };
  }

  const existing = runningHeadlessClients.get(id) || [];
  const MAX_HEADLESS_CLIENTS = 3;
  if (existing.length >= MAX_HEADLESS_CLIENTS) {
    return {
      ok: false,
      message: `Maximum of ${MAX_HEADLESS_CLIENTS} headless clients already running for this server.`
    };
  }

  const { exe, args } = buildHeadlessClientCommand(server);
  console.log(`Starting headless client for ${id}: ${exe} ${args.join(' ')}`);

  const child = spawn(exe, args, {
    cwd: ARMA3_PATH || undefined,
    detached: true,
    stdio: 'ignore'
  });

  child.on('error', (err) => {
    console.error(`Headless client failed to start for ${id}`, err);
  });

  const pid = child.pid;
  if (pid) {
    const pids = runningHeadlessClients.get(id) || [];
    pids.push(pid);
    runningHeadlessClients.set(id, pids);
  }
  child.unref();

  return { ok: true, message: 'Headless client launch issued (connects to 127.0.0.1)' };
}

function stopHeadlessClient(id, pid) {
  const current = runningHeadlessClients.get(id) || [];
  const targetPid = Number(pid);

  if (!current.includes(targetPid)) {
    return { ok: false, message: 'Headless client not found for this server' };
  }

  console.log(`Stopping headless client for ${id}, PID ${targetPid}`);
  spawnTaskkill(targetPid, `${id} headless client`);

  const remaining = current.filter((p) => p !== targetPid);
  if (remaining.length > 0) {
    runningHeadlessClients.set(id, remaining);
  } else {
    runningHeadlessClients.delete(id);
  }

  return { ok: true, message: `Headless client ${targetPid} stop command issued` };
}

// API routes - servers

// CRUD for server definitions (name/ports/paths/mods)
app.get('/api/server-definitions', requireAuth, requireServerControl, (req, res) => {
  res.json(servers);
});

app.post('/api/server-definitions', requireAuth, requireServerControl, (req, res) => {
  const {
    name,
    port,
    profileId,
    mods,
    serverMods,
    extraArgs,
    configPath,
    basicConfigPath,
    profilesPath,
    serverPassword
  } = req.body || {};

  if (!name || !port || !profileId) {
    return res.status(400).json({
      ok: false,
      message: 'name, port, and profileId are required'
    });
  }

  const id = `srv_${Date.now()}`;

  const server = {
    id,
    name,
    port: Number(port),
    profileId,
    mods: mods || '',
    serverMods: serverMods || '',
    extraArgs: extraArgs || '',
    configPath: configPath || '',
    basicConfigPath: basicConfigPath || '',
    profilesPath: profilesPath || '',
    serverPassword: serverPassword || ''
  };

  servers.push(server);
  saveServers(servers);

  audit(req, 'server-definition:create', {
    server
  });

  return res.status(201).json({ ok: true, server });
});

app.put('/api/server-definitions/:id', requireAuth, requireServerControl, (req, res) => {
  const id = req.params.id;
  const index = servers.findIndex((s) => s.id === id);

  if (index === -1) {
    return res.status(404).json({ ok: false, message: 'Server not found' });
  }

  const {
    name,
    port,
    profileId,
    mods,
    serverMods,
    extraArgs,
    configPath,
    basicConfigPath,
    profilesPath,
    serverPassword
  } = req.body || {};

  const current = servers[index];
  const updated = {
    ...current,
    name: name ?? current.name,
    port: port !== undefined ? Number(port) : current.port,
    profileId: profileId ?? current.profileId,
    mods: mods !== undefined ? mods : current.mods,
    serverMods: serverMods !== undefined ? serverMods : current.serverMods,
    extraArgs: extraArgs !== undefined ? extraArgs : current.extraArgs,
    configPath: configPath !== undefined ? configPath : current.configPath,
    basicConfigPath:
      basicConfigPath !== undefined ? basicConfigPath : current.basicConfigPath,
    profilesPath: profilesPath !== undefined ? profilesPath : current.profilesPath,
    serverPassword: serverPassword !== undefined ? serverPassword : current.serverPassword
  };

  servers[index] = updated;
  saveServers(servers);

  audit(req, 'server-definition:update', {
    id,
    before: current,
    after: updated
  });

  return res.json({ ok: true, server: updated });
});

app.get(
  '/api/server-definitions/:id/mission-template',
  requireAuth,
  requireServerControl,
  async (req, res) => {
    const id = req.params.id;
    const server = servers.find((s) => s.id === id);
    if (!server) {
      return res.status(404).json({ ok: false, message: 'Server not found' });
    }
    if (!ARMA3_MISSION_PATH) {
      return res
        .status(400)
        .json({ ok: false, message: 'ARMA3_MISSION_PATH is not configured.' });
    }

    const { configPath } = resolveServerPaths(server);

    try {
      const entries = await fs.promises.readdir(ARMA3_MISSION_PATH);
      const missions = [];
      for (const name of entries) {
        if (!name.toLowerCase().endsWith('.pbo')) continue;
        const templateName = missionTemplateFromFileName(name);
        let displayName = templateName;
        try {
          displayName = decodeURIComponent(templateName);
        } catch (_) {
          // keep raw templateName when not URL encoded
        }
        missions.push({
          fileName: name,
          templateName,
          displayName
        });
      }
      missions.sort((a, b) => a.displayName.localeCompare(b.displayName));

      let currentTemplate = '';
      if (fs.existsSync(configPath)) {
        const configText = await fs.promises.readFile(configPath, 'utf8');
        const match = configText.match(
          /(class\s+Missions\s*\{[\s\S]*?template\s*=\s*")([^"]*)(";\s*)/i
        );
        if (match && typeof match[2] === 'string') {
          currentTemplate = match[2];
        }
      }

      return res.json({
        ok: true,
        serverId: id,
        serverName: server.name,
        configPath,
        currentTemplate,
        missions
      });
    } catch (err) {
      console.error('Failed to load mission template options', err);
      return res
        .status(500)
        .json({ ok: false, message: 'Failed to load mission templates.' });
    }
  }
);

app.put(
  '/api/server-definitions/:id/mission-template',
  requireAuth,
  requireServerControl,
  async (req, res) => {
    const id = req.params.id;
    const server = servers.find((s) => s.id === id);
    if (!server) {
      return res.status(404).json({ ok: false, message: 'Server not found' });
    }

    const template = String((req.body && req.body.template) || '').trim();
    if (!template) {
      return res.status(400).json({ ok: false, message: 'Template is required.' });
    }
    if (template.includes('"') || template.includes('\n') || template.includes('\r')) {
      return res.status(400).json({ ok: false, message: 'Template contains invalid characters.' });
    }

    const { configPath } = resolveServerPaths(server);

    try {
      const configText = await fs.promises.readFile(configPath, 'utf8');
      const missionsTemplateRegex =
        /(class\s+Missions\s*\{[\s\S]*?template\s*=\s*")([^"]*)(";\s*)/i;
      if (!missionsTemplateRegex.test(configText)) {
        return res.status(400).json({
          ok: false,
          message:
            'Could not find template = "..." inside class Missions in server_config.cfg.'
        });
      }

      const updatedConfig = configText.replace(
        missionsTemplateRegex,
        (_, prefix, _currentValue, suffix) => `${prefix}${template}${suffix}`
      );

      await fs.promises.writeFile(configPath, updatedConfig, 'utf8');

      console.log(
        `User ${req.session.username || 'unknown'} updated mission template for server '${getServerDisplayLabel(
          id
        )}' to '${template}'`
      );
      audit(req, 'server-definition:mission-template:update', {
        id,
        template,
        configPath
      });

      return res.json({
        ok: true,
        message: `Mission template updated to "${template}" for ${server.name}.`,
        template,
        configPath
      });
    } catch (err) {
      console.error('Failed to update mission template', err);
      if (err.code === 'ENOENT') {
        return res.status(404).json({
          ok: false,
          message: `server_config.cfg not found: ${configPath}`
        });
      }
      return res
        .status(500)
        .json({ ok: false, message: 'Failed to update mission template.' });
    }
  }
);

app.get('/api/servers', requireAuth, requireServerControl, (req, res) => {
  const list = servers.map((s) => {
    const info = running.get(s.id);
    const headless = runningHeadlessClients.get(s.id) || [];
    return {
      id: s.id,
      name: s.name,
      status: info ? info.status : 'stopped',
      pid: info ? info.process.pid : null,
      startedAt: info ? info.startedAt : null,
      headlessClients: headless
    };
  });
  res.json(list);
});

app.post('/api/servers/:id/start', requireAuth, requireServerControl, (req, res) => {
  const id = req.params.id;
  const displayName = getServerDisplayLabel(id);
  const result = startServer(id);
  console.log(
    `User ${req.session.username || 'unknown'} requested START for server '${displayName}' – ${
      result.ok ? 'accepted' : 'rejected'
    }: ${result.message}`
  );
  audit(req, 'server:start', { id, result });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/servers/:id/stop', requireAuth, requireServerControl, (req, res) => {
  const id = req.params.id;
  const displayName = getServerDisplayLabel(id);
  const result = stopServer(id);
  console.log(
    `User ${req.session.username || 'unknown'} requested STOP for server '${displayName}' – ${
      result.ok ? 'accepted' : 'rejected'
    }: ${result.message}`
  );
  audit(req, 'server:stop', { id, result });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/servers/:id/headless-client', requireAuth, requireServerControl, (req, res) => {
  const id = req.params.id;
  const displayName = getServerDisplayLabel(id);
  const result = startHeadlessClient(id);
  console.log(
    `User ${req.session.username || 'unknown'} requested HEADLESS CLIENT for server '${displayName}' – ${
      result.ok ? 'accepted' : 'rejected'
    }: ${result.message}`
  );
  audit(req, 'server:headless-client', { id, result });
  res.status(result.ok ? 200 : 400).json(result);
});

app.post(
  '/api/servers/:id/headless-client/:pid/stop',
  requireAuth,
  requireServerControl,
  (req, res) => {
    const id = req.params.id;
    const pid = req.params.pid;
    const displayName = getServerDisplayLabel(id);
    const result = stopHeadlessClient(id, pid);
    console.log(
      `User ${req.session.username || 'unknown'} requested STOP for headless client ${pid} on server '${displayName}' – ${
        result.ok ? 'accepted' : 'rejected'
      }: ${result.message}`
    );
    audit(req, 'server:headless-client:stop', { id, pid, result });
    res.status(result.ok ? 200 : 400).json(result);
  }
);

app.get('/api/console/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  logBuffer.forEach((line) => {
    res.write(`data: ${JSON.stringify(line)}\n\n`);
  });
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Mission file APIs (list / upload / delete)
let missionsEnabled = false;
let upload;

if (ARMA3_MISSION_PATH) {
  // Ensure the directory exists before using it
  if (!fs.existsSync(ARMA3_MISSION_PATH)) {
    console.warn(
      `ARMA3_MISSION_PATH '${ARMA3_MISSION_PATH}' does not exist – mission API disabled.`
    );
  } else {
    missionsEnabled = true;

    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, ARMA3_MISSION_PATH);
      },
      filename: (req, file, cb) => {
        // Save using original filename (overwrite if exists)
        cb(null, file.originalname);
      }
    });

    upload = multer({ storage });

    app.get('/api/missions', async (req, res) => {
      try {
        const entries = await fs.promises.readdir(ARMA3_MISSION_PATH);
        const files = [];

        for (const name of entries) {
          const fullPath = path.join(ARMA3_MISSION_PATH, name);
          const stat = await fs.promises.stat(fullPath);
          if (stat.isFile()) {
            files.push({
              name,
              size: stat.size,
              mtime: stat.mtime
            });
          }
        }

        res.json({
          path: ARMA3_MISSION_PATH,
          files
        });
      } catch (err) {
        console.error('Error listing missions', err);
        res.status(500).json({ ok: false, message: 'Failed to list missions' });
      }
    });

    app.post(
      '/api/missions/upload',
      requireAuth,
      requireFileUpload,
      upload.single('mission'),
      async (req, res) => {
        if (!req.file) {
          return res
            .status(400)
            .json({ ok: false, message: 'No file uploaded (field name: mission)' });
        }

        const name = req.file.originalname || '';
        const lower = name.toLowerCase();
        if (!lower.endsWith('.pbo')) {
          try {
            await fs.promises.unlink(req.file.path);
          } catch (err) {
            console.error('Failed to delete non-PBO upload', err);
          }

          return res.status(400).json({
            ok: false,
            message: 'Only .pbo mission files are allowed.'
          });
        }
        const responsePayload = {
          ok: true,
          message: `Uploaded ${req.file.originalname}`,
          file: {
            name: req.file.originalname,
            size: req.file.size
          }
        };

        console.log(
          `User ${req.session.username || 'unknown'} uploaded mission '${req.file.originalname}' (${req.file.size} bytes)`
        );
        audit(req, 'mission:upload', {
          file: {
            name: req.file.originalname,
            size: req.file.size
          }
        });

        return res.json(responsePayload);
      }
    );

    app.get('/api/missions/download/:name', (req, res) => {
      const fileName = req.params.name;
      // Basic safety: do not allow path separators
      if (fileName.includes('/') || fileName.includes('\\')) {
        return res.status(400).json({ ok: false, message: 'Invalid filename' });
      }

      const target = path.join(ARMA3_MISSION_PATH, fileName);

      res.download(target, fileName, (err) => {
        if (err) {
          console.error('Error downloading mission', err);
          if (!res.headersSent) {
            if (err.code === 'ENOENT') {
              res
                .status(404)
                .json({ ok: false, message: 'File not found for download' });
            } else {
              res
                .status(500)
                .json({ ok: false, message: 'Failed to download mission' });
            }
          }
        }
      });
    });

    app.delete(
      '/api/missions/:name',
      requireAuth,
      requireFileUpload,
      async (req, res) => {
        const fileName = req.params.name;
        if (fileName.includes('/') || fileName.includes('\\')) {
          return res.status(400).json({ ok: false, message: 'Invalid filename' });
        }

        const target = path.join(ARMA3_MISSION_PATH, fileName);

        try {
          await fs.promises.unlink(target);
          console.log(
            `User ${req.session.username || 'unknown'} deleted mission '${fileName}' via DELETE`
          );
          audit(req, 'mission:delete', { fileName });
          res.json({ ok: true, message: `Deleted ${fileName}` });
        } catch (err) {
          console.error('Error deleting mission', err);
          if (err.code === 'ENOENT') {
            res.status(404).json({ ok: false, message: 'File not found' });
          } else {
            res.status(500).json({ ok: false, message: 'Failed to delete file' });
          }
        }
      }
    );

    // Alternative API endpoints using POST instead of DELETE/GET-only,
    // which can be helpful behind certain reverse proxies (e.g. IIS)
    // that restrict HTTP verbs.
    app.post(
      '/api/missions/delete',
      requireAuth,
      requireFileUpload,
      async (req, res) => {
        const fileName = (req.body && req.body.name) || '';
        if (!fileName) {
          return res.status(400).json({ ok: false, message: 'Missing mission name' });
        }
        if (fileName.includes('/') || fileName.includes('\\')) {
          return res.status(400).json({ ok: false, message: 'Invalid filename' });
        }

        const target = path.join(ARMA3_MISSION_PATH, fileName);

        try {
          await fs.promises.unlink(target);
          console.log(
            `User ${req.session.username || 'unknown'} deleted mission '${fileName}' via POST`
          );
          audit(req, 'mission:delete', { fileName });
          res.json({ ok: true, message: `Deleted ${fileName}` });
        } catch (err) {
          console.error('Error deleting mission via POST API', err);
          if (err.code === 'ENOENT') {
            res.status(404).json({ ok: false, message: 'File not found' });
          } else {
            res.status(500).json({ ok: false, message: 'Failed to delete file' });
          }
        }
      }
    );

    app.post(
      '/api/missions/download',
      requireAuth,
      requireFileUpload,
      (req, res) => {
        const fileName = (req.body && req.body.name) || '';
        if (!fileName) {
          return res.status(400).json({ ok: false, message: 'Missing mission name' });
        }
        if (fileName.includes('/') || fileName.includes('\\')) {
          return res.status(400).json({ ok: false, message: 'Invalid filename' });
        }

        const target = path.join(ARMA3_MISSION_PATH, fileName);

        console.log(
          `User ${req.session.username || 'unknown'} requested mission download for '${fileName}' via POST`
        );
        res.download(target, fileName, (err) => {
          if (err) {
            console.error('Error downloading mission via POST API', err);
            if (!res.headersSent) {
              if (err.code === 'ENOENT') {
                res
                  .status(404)
                  .json({ ok: false, message: 'File not found for download' });
              } else {
                res
                  .status(500)
                  .json({ ok: false, message: 'Failed to download mission' });
              }
            }
          }
        });
      }
    );
  }
}

// Public operations pages (Halo/mission themed)
// Serve a static, editable HTML template and hydrate it client-side.
function buildDiscordEmbedDescription(text) {
  return String(text || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function getBaseUrl(req) {
  const proto = (req.headers && req.headers['x-forwarded-proto']) || req.protocol || 'http';
  const host = req.headers && req.headers.host ? String(req.headers.host) : 'localhost:3000';
  return `${proto}://${host}`;
}

app.get('/ops/:friendlyName', (req, res) => {
  try {
    const friendlyName = String(req.params.friendlyName || '');
    const op = getOpByFriendlyName(friendlyName);

    if (!op) {
      return res.status(404).send(
        `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />` +
          `<title>Operation not found</title></head><body style="font-family:system-ui;margin:40px;background:#000;color:#c9d5cc;">` +
          `<h1 style="margin-top:0;">Operation not found</h1>` +
          `<p>Could not find an operation matching <code>${escapeHtml(friendlyName)}</code>.</p>` +
          `</body></html>`
      );
    }

    const baseUrl = getBaseUrl(req);
    const opTitle = op.Operationtitle || op.opfreindlyname || 'Operation';
    const mission = op.missionstatement || '';
    const discordDesc = buildDiscordEmbedDescription(mission);

    const meta = `
<meta name="description" content="${escapeHtml(discordDesc)}" />
<meta property="og:title" content="${escapeHtml(opTitle)}" />
<meta property="og:description" content="${escapeHtml(discordDesc)}" />
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeHtml(`${baseUrl}/ops/${encodeURIComponent(op.opfreindlyname)}`)}" />
<meta property="og:image" content="${escapeHtml(`${baseUrl}/unsc_logo.png`)}" />
<meta property="og:image:alt" content="${escapeHtml(opTitle)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(opTitle)}" />
<meta name="twitter:description" content="${escapeHtml(discordDesc)}" />
<meta name="twitter:image" content="${escapeHtml(`${baseUrl}/unsc_logo.png`)}" />
<!--__OP_META__-->`;

    const templatePath = path.join(__dirname, 'public', 'ops.html');
    let html = '';
    try {
      html = fs.readFileSync(templatePath, 'utf8');
    } catch (readErr) {
      console.error('Failed to read ops template', readErr);
      return res.status(500).send('Failed to render operation page.');
    }
    html = html.replace('<!--__OP_TITLE__-->', escapeHtml(opTitle));
    html = html.replace('<!--__OP_META__-->', meta);

    // Safety: remove any leftover placeholders if templates changed.
    html = html.replace(/<!--__OP_META__-->/g, '');
    html = html.replace(/<!--__OP_TITLE__-->/g, escapeHtml(opTitle));

    res.status(200).contentType('text/html').send(html);
  } catch (err) {
    console.error('Failed to render ops HTML', err);
    res.status(500).send('Failed to render operation page.');
  }
});

// Public operations dashboard
// NOTE: `/ops/:friendlyName` is still used for individual ops.
app.get('/ops', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ops-dashboard.html'));
});

// Backwards-compatible alias
app.get('/ops-dashboard', (req, res) => {
  res.redirect('/ops');
});

// Operation data API for the ops page
app.get('/api/ops/:friendlyName', (req, res) => {
  try {
    const friendlyName = String(req.params.friendlyName || '');
    const op = getOpByFriendlyName(friendlyName);
    if (!op) {
      return res.status(404).json({ ok: false, message: 'Operation not found' });
    }

    const terrainConditions = op.terrainConditions || TERRAIN_CONDITIONS;
    const optionalobjectives = Array.isArray(op.optionalobjectives) ? op.optionalobjectives : [];
    const date = op.date || DEFAULT_OP_META.date;
    const planet = op.planet || DEFAULT_OP_META.planet;
    const sector = op.sector || DEFAULT_OP_META.sector;
    const opposingforce = op.opposingforce || DEFAULT_OP_META.opposingforce;

    return res.json({
      ok: true,
      operation: {
        ...op,
        terrainConditions,
        optionalobjectives,
        date,
        planet,
        sector,
        opposingforce
      }
    });
  } catch (err) {
    console.error('Failed to load ops data', err);
    return res.status(500).json({ ok: false, message: 'Failed to load operation' });
  }
});

// Public dashboard data: list all operations sorted by postedTime asc
app.get('/api/ops', (req, res) => {
  try {
    const ops = getOps();
    const sorted = [...ops].sort((a, b) => {
      const ta = a && a.postedTime ? Date.parse(String(a.postedTime)) : Number.POSITIVE_INFINITY;
      const tb = b && b.postedTime ? Date.parse(String(b.postedTime)) : Number.POSITIVE_INFINITY;
      if (ta === tb) return 0;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return ta - tb;
    });

    return res.json({ ok: true, ops: sorted });
  } catch (err) {
    console.error('Failed to list ops', err);
    return res.status(500).json({ ok: false, message: 'Failed to list operations' });
  }
});

// Admin API: create a new operation entry in ops.json
app.post('/api/ops', requireAuth, requireServerControl, (req, res) => {
  try {
    const payload = req.body || {};

    const operationtitle = String(payload.Operationtitle || '').trim();
    const opfreindlyname = String(payload.opfreindlyname || '').trim();

    const postedTime = new Date().toISOString();

    const date = String(payload.date || '').trim() || DEFAULT_OP_META.date;
    const planet = String(payload.planet || '').trim() || DEFAULT_OP_META.planet;
    const sector = String(payload.sector || '').trim() || DEFAULT_OP_META.sector;
    const opposingforce =
      String(payload.opposingforce || '').trim() || DEFAULT_OP_META.opposingforce;

    // Editable terrain/battle-condition fields (timeline remains static)
    const environmentalElements =
      String(payload.environmentalElements || '').trim() ||
      TERRAIN_CONDITIONS.environmentalElements;
    const timeOfDay =
      String(payload.timeOfDay || '').trim() || TERRAIN_CONDITIONS.timeOfDay;
    const terrain =
      String(payload.terrain || '').trim() || TERRAIN_CONDITIONS.terrain;
    const localsPresence =
      String(payload.localsPresence || '').trim() || TERRAIN_CONDITIONS.localsPresence;
    const planopsLink =
      String(payload.planopsLink || '').trim() || TERRAIN_CONDITIONS.planopsLink;

    const missionstatement = String(payload.missionstatement || '').trim();
    const opdescription = String(payload.opdescription || '').trim();

    const mainobjective = String(payload.mainobjective || '').trim();
    const secondaryobjective = String(payload.secondaryobjective || '').trim();

    let optionalobjectives = [];
    if (Array.isArray(payload.optionalobjectives)) {
      optionalobjectives = payload.optionalobjectives
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    } else if (typeof payload.optionalobjectives === 'string') {
      optionalobjectives = payload.optionalobjectives
        .split(/\r?\n/g)
        .map((x) => String(x || '').trim())
        .filter(Boolean);
    }

    if (!operationtitle || !opfreindlyname || !missionstatement || !opdescription || !mainobjective || !secondaryobjective) {
      return res.status(400).json({
        ok: false,
        message:
          'Missing required fields. Required: Operationtitle, opfreindlyname, missionstatement, opdescription, mainobjective, secondaryobjective.'
      });
    }

    const normalizedFriendly = normalizeFriendlyName(opfreindlyname);
    if (!normalizedFriendly) {
      return res.status(400).json({ ok: false, message: 'Invalid opfreindlyname.' });
    }

    const ops = [...getOps()];
    const existing = ops.find(
      (o) => normalizeFriendlyName(o.opfreindlyname) === normalizedFriendly
    );

    if (existing) {
      return res.status(409).json({
        ok: false,
        message: `Operation with opfreindlyname '${normalizedFriendly}' already exists.`
      });
    }

    const operation = {
      Operationtitle: operationtitle,
      opfreindlyname: normalizedFriendly,
      date,
      planet,
      sector,
      opposingforce,
      postedTime,
      missionstatement,
      opdescription,
      mainobjective,
      secondaryobjective,
      optionalobjectives,
      terrainConditions: {
        ...TERRAIN_CONDITIONS,
        environmentalElements,
        timeOfDay,
        terrain,
        localsPresence,
        planopsLink
      }
    };

    ops.push(operation);
    saveOps(ops);

    audit(req, 'ops:create', {
      operation: {
        opfreindlyname: operation.opfreindlyname,
        Operationtitle: operation.Operationtitle
      }
    });

    return res.status(201).json({ ok: true, operation });
  } catch (err) {
    console.error('Failed to create operation', err);
    return res.status(500).json({ ok: false, message: 'Failed to create operation.' });
  }
});

// Static frontend (protected)
// Public image used by the /ops page (avoid forcing login just to load the logo).
app.get('/unsc_logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'unsc_logo.png'));
});

app.get(
  '/',
  requireAuth,
  (req, res, next) => {
    const roles = getSessionRoles(req);
    if (!roles.canUpload && !roles.canControlServers) {
      res
        .status(403)
        .sendFile(path.join(__dirname, 'public', 'no-access.html'));
      return;
    }
    next();
  },
  (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
);

app.use(requireAuth, express.static(path.join(__dirname, 'public')));

// Centralized fallback error handler so unexpected route errors
// produce a controlled 500 instead of tearing down request handling.
app.use((err, req, res, next) => {
  console.error('Unhandled request error', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({
    ok: false,
    message: 'Unexpected server error'
  });
});

const server = http.createServer(app);

// Behind IIS/ARR, keep-alive must outlive the proxy’s connection reuse window.
// If Node closes the socket first, ARR can return 502 on the next reused request.
const keepAliveMs = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 90000);
server.keepAliveTimeout = keepAliveMs;
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || keepAliveMs + 1000);
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 120000);

const activeSockets = new Set();
server.on('connection', (socket) => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
});

function shutdown(signal) {
  console.warn(`Received ${signal}; shutting down HTTP server gracefully.`);
  server.close(() => {
    console.log('HTTP server closed.');
    process.exit(0);
  });

  // Force close lingering sockets so shutdown does not hang forever.
  setTimeout(() => {
    activeSockets.forEach((socket) => socket.destroy());
  }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const LISTEN_HOST = process.env.LISTEN_HOST || undefined;

function onListen() {
  const where = LISTEN_HOST ? `http://${LISTEN_HOST}:${PORT}` : `http://localhost:${PORT}`;
  console.log(`Arma 3 control panel listening on ${where}`);
  if (missionsEnabled) {
    console.log(
      `Mission file API enabled at ${ARMA3_MISSION_PATH} (GET/POST/DELETE /api/missions...)`
    );
  } else {
    console.log('Mission file API is disabled – check ARMA3_MISSION_PATH in .env');
  }
}

if (LISTEN_HOST) {
  server.listen(PORT, LISTEN_HOST, onListen);
} else {
  server.listen(PORT, onListen);
}
