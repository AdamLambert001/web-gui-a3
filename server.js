require('dotenv').config();

const fs = require('fs');
const path = require('path');
const util = require('util');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');
const session = require('express-session');

const app = express();
const PORT = 3000;

// Environment configuration
const ARMA3_PATH = process.env.ARMA3_PATH;
const ARMA3_MISSION_PATH = process.env.ARMA3_MISSION_PATH;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'password';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-session-secret';

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

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 10 * 60 * 1000 // 10 minutes of inactivity
    },
    rolling: true // reset expiry on each request
  })
);

function requireAuth(req, res, next) {
  // Missions API is allowed without authentication
  if (req.path && req.path.startsWith('/api/missions')) {
    return next();
  }

  if (req.session && req.session.authenticated) {
    return next();
  }

  // For API routes, return JSON instead of HTML redirects
  if (req.path && req.path.startsWith('/api/')) {
    return res.status(401).json({
      ok: false,
      message: 'Not authenticated – please reload and log in again.'
    });
  }

  return res.redirect('/login');
}

// Optional: root folder where you keep per-server profiles/configs.
// Adjust or replace if your layout is different.
const ARMA3_SERVERS_ROOT = ARMA3_PATH
  ? path.join(ARMA3_PATH, 'Servers')
  : 'G:\\Arma\\Servers';

// Path for persisted server definitions
const SERVERS_CONFIG_FILE = path.join(__dirname, 'servers.json');

// In-memory log buffer and SSE for web console
const MAX_LOG_LINES = 500;
const logBuffer = [];
const sseClients = new Set();

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
    fs.writeFileSync(SERVERS_CONFIG_FILE, JSON.stringify(servers, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write servers.json', err);
  }
}

let servers = loadServers();

// Authentication routes
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.redirect('/');
  }

  return res.status(401).sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

function buildServerCommand(server) {
  const exe = ARMA3_PATH
    ? path.join(ARMA3_PATH, 'arma3server_x64.exe')
    : 'arma3server_x64.exe';

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

// Arma 3 server_console_* log tail per server (so we stream it into the web console)
const serverLogTails = new Map();
const SERVER_LOG_POLL_MS = 1500;
const SERVER_LOG_TAIL_DELAY_MS = 5000; // short delay before first check
const SERVER_LOG_TAIL_RETRY_MS = 1000; // check every 1s for a new file
const SERVER_LOG_TAIL_RETRY_ATTEMPTS = 90; // keep trying for ~90s until file appears
const SERVER_LOG_MTIME_TOLERANCE_MS = 2000; // treat file as "new" if mtime is within 2s of start

function getProfileRoot(server) {
  return server.profilesPath && server.profilesPath.trim().length > 0
    ? server.profilesPath
    : path.join(ARMA3_SERVERS_ROOT, server.profileId);
}

/**
 * Returns the most recently modified server_console_* file that was created/updated
 * after startTime (so we tail the log for this run, not an old one). Returns null if none.
 */
function findServerConsoleLogAfter(profileRoot, startTime) {
  try {
    const names = fs.readdirSync(profileRoot).filter((n) => n.startsWith('server_console_'));
    if (names.length === 0) return null;
    const cutoff = startTime - SERVER_LOG_MTIME_TOLERANCE_MS;
    const withStat = names
      .map((n) => {
        const p = path.join(profileRoot, n);
        const st = fs.statSync(p);
        return { path: p, mtime: st.mtimeMs };
      })
      .filter((f) => f.mtime >= cutoff);
    if (withStat.length === 0) return null;
    withStat.sort((a, b) => b.mtime - a.mtime);
    return withStat[0].path;
  } catch (_) {
    return null;
  }
}

function startServerLogTail(id, profileRoot, startTime) {
  function tryStart() {
    const logPath = findServerConsoleLogAfter(profileRoot, startTime);
    if (!logPath) return false;
    let lastSize = 0;
    try {
      const st = fs.statSync(logPath);
      lastSize = st.size;
    } catch (_) {}

    const intervalId = setInterval(async () => {
      const tail = serverLogTails.get(id);
      if (!tail) return;
      try {
        const st = await fs.promises.stat(tail.logPath);
        if (st.size > tail.lastSize) {
          const fd = await fs.promises.open(tail.logPath, 'r');
          const buf = Buffer.alloc(st.size - tail.lastSize);
          await fd.read(buf, 0, buf.length, tail.lastSize);
          await fd.close();
          tail.lastSize = st.size;
          const text = buf.toString('utf8');
          text.split(/\r?\n/).forEach((line) => {
            const t = line.trim();
            if (t) broadcastLog('log', `[${id}] ${t}`);
          });
        }
      } catch (_) {}
    }, SERVER_LOG_POLL_MS);

    serverLogTails.set(id, { logPath, lastSize, intervalId });
    console.log(`[${id}] Tailing Arma console log: ${logPath}`);
    return true;
  }

  let attempts = 0;
  const t = setInterval(() => {
    attempts++;
    if (tryStart()) {
      clearInterval(t);
      return;
    }
    if (attempts >= SERVER_LOG_TAIL_RETRY_ATTEMPTS) {
      clearInterval(t);
    }
  }, SERVER_LOG_TAIL_RETRY_MS);
}

function stopServerLogTail(id) {
  const tail = serverLogTails.get(id);
  if (tail) {
    clearInterval(tail.intervalId);
    serverLogTails.delete(id);
  }
}

function getStatus(id) {
  const info = running.get(id);
  return info ? info.status : 'stopped';
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

  const profileRoot = getProfileRoot(server);
  const startTime = startedAt.getTime();
  setTimeout(() => startServerLogTail(id, profileRoot, startTime), SERVER_LOG_TAIL_DELAY_MS);

  child.stdout.on('data', (data) => {
    console.log(`[${id}] ${data}`);
    info.status = 'running';
  });

  child.stderr.on('data', (data) => {
    console.error(`[${id} ERROR] ${data}`);
  });

  child.on('exit', (code, signal) => {
    stopServerLogTail(id);
    console.log(`Server ${id} exited with code ${code}, signal ${signal}`);
    // Kill any headless clients that were started for this server
    const hcPids = runningHeadlessClients.get(id);
    if (hcPids && hcPids.length > 0) {
      console.log(`Stopping ${hcPids.length} headless client(s) for ${id}`);
      for (const hcPid of hcPids) {
        spawn('taskkill', ['/PID', String(hcPid), '/T', '/F']);
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
  const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);

  killer.on('exit', (code) => {
    console.log(`taskkill for ${id} exited with code ${code}`);
  });

  // Kill any headless clients that were started for this server
  const hcPids = runningHeadlessClients.get(id);
  if (hcPids && hcPids.length > 0) {
    console.log(`Stopping ${hcPids.length} headless client(s) for ${id}: PIDs ${hcPids.join(', ')}`);
    for (const hcPid of hcPids) {
      spawn('taskkill', ['/PID', String(hcPid), '/T', '/F']);
    }
    runningHeadlessClients.delete(id);
  }

  stopServerLogTail(id);
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

  const { exe, args } = buildHeadlessClientCommand(server);
  console.log(`Starting headless client for ${id}: ${exe} ${args.join(' ')}`);

  const child = spawn(exe, args, {
    cwd: ARMA3_PATH || undefined,
    detached: true,
    stdio: 'ignore'
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

// API routes - servers

// CRUD for server definitions (name/ports/paths/mods)
app.get('/api/server-definitions', requireAuth, (req, res) => {
  res.json(servers);
});

app.post('/api/server-definitions', requireAuth, (req, res) => {
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

  return res.status(201).json({ ok: true, server });
});

app.put('/api/server-definitions/:id', requireAuth, (req, res) => {
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

  return res.json({ ok: true, server: updated });
});

app.get('/api/servers', requireAuth, (req, res) => {
  const list = servers.map((s) => {
    const info = running.get(s.id);
    return {
      id: s.id,
      name: s.name,
      status: info ? info.status : 'stopped',
      pid: info ? info.process.pid : null,
      startedAt: info ? info.startedAt : null
    };
  });
  res.json(list);
});

app.post('/api/servers/:id/start', requireAuth, (req, res) => {
  const id = req.params.id;
  const result = startServer(id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/servers/:id/stop', requireAuth, (req, res) => {
  const id = req.params.id;
  const result = stopServer(id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/servers/:id/headless-client', requireAuth, (req, res) => {
  const id = req.params.id;
  const result = startHeadlessClient(id);
  res.status(result.ok ? 200 : 400).json(result);
});

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

    app.post('/api/missions/upload', upload.single('mission'), async (req, res) => {
      if (!req.file) {
        return res
          .status(400)
          .json({ ok: false, message: 'No file uploaded (field name: mission)' });
      }

      const name = req.file.originalname || '';
      const lower = name.toLowerCase();
      if (!lower.endsWith('.pbo')) {
        // Remove the uploaded non-PBO file
        try {
          await fs.promises.unlink(req.file.path);
        } catch (err) {
          // Best-effort cleanup; log but don't crash
          console.error('Failed to delete non-PBO upload', err);
        }

        return res.status(400).json({
          ok: false,
          message: 'Only .pbo mission files are allowed.'
        });
      }

      return res.json({
        ok: true,
        message: `Uploaded ${req.file.originalname}`,
        file: {
          name: req.file.originalname,
          size: req.file.size
        }
      });
    });

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

    app.delete('/api/missions/:name', async (req, res) => {
      const fileName = req.params.name;
      // Basic safety: do not allow path separators
      if (fileName.includes('/') || fileName.includes('\\')) {
        return res.status(400).json({ ok: false, message: 'Invalid filename' });
      }

      const target = path.join(ARMA3_MISSION_PATH, fileName);

      try {
        await fs.promises.unlink(target);
        res.json({ ok: true, message: `Deleted ${fileName}` });
      } catch (err) {
        console.error('Error deleting mission', err);
        if (err.code === 'ENOENT') {
          res.status(404).json({ ok: false, message: 'File not found' });
        } else {
          res.status(500).json({ ok: false, message: 'Failed to delete file' });
        }
      }
    });
  }
}

// Static frontend (protected)
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(requireAuth, express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Arma 3 control panel listening on http://localhost:${PORT}`);
  if (missionsEnabled) {
    console.log(
      `Mission file API enabled at ${ARMA3_MISSION_PATH} (GET/POST/DELETE /api/missions...)`
    );
  } else {
    console.log('Mission file API is disabled – check ARMA3_MISSION_PATH in .env');
  }
});
