require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const multer = require('multer');

const app = express();
const PORT = 3000;

// Environment configuration
const ARMA3_PATH = process.env.ARMA3_PATH;
const ARMA3_MISSION_PATH = process.env.ARMA3_MISSION_PATH;

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
app.use(express.static(path.join(__dirname, 'public')));

// Optional: root folder where you keep per-server profiles/configs.
// Adjust or replace if your layout is different.
const ARMA3_SERVERS_ROOT = ARMA3_PATH
  ? path.join(ARMA3_PATH, 'Servers')
  : 'G:\\Arma\\Servers';

// Configure your Arma 3 servers here.
// Each entry only defines metadata; the full command line is built
// automatically from ARMA3_PATH and these fields.
const servers = [
  {
    id: 'server1',
    name: 'Arma 3 Server 1',
    port: 2302,
    profileId: '_11c5c3e7231e4816af4cc9adba2048a2',
    mods:
      '@3den_Enhanced;@CBA_A3;@Operation_TREBUCHET;@ace;@Zeus_Enhanced;@UNSC_Foundries;@Remove_stamina;@Misriah_Armory;@Improved_Melee_System;@Operation_TREBUCHET_First_Contact;@ACE3_Arsenal_Extended__Core;@Operation_Trebuchet_PLUS_;@Task_Force_Arrowhead_Radio_BETA__;@ACE_3_Extension_Animations_and_Actions_;@ACE_3_Extension_Gestures_;@ACE_Interaction_Menu_Expansion;@Alternative_Running;@CH_View_Distance;@Crows_Zeus_Additions;@CUP_Terrains__Core;@DUI__Squad_Radar;@Eden_Extended_Objects;@Eden_Objects;@EnhancedTrenches;@Fire_Support_Plus;@Global_Ops_Terrains;@Halo_Map_Markers;@Halo_Music_Collection;@Jbad;@No_More_Aircraft_Bouncing;@No_Weapon_Sway;@Remove_stamina__ACE_3;@Sci_fi_Support_Plus;@UNSC_Foundries_Ace_Compat;@Weather_Plus;@WMO__Walkable_Moving_Objects;@ZEI__Zeus_and_Eden_Interiors;@cTab;@Crows_Electronic_Warfare;@The_Cole_Protocol;@41st_ODST_MFR__Declassified_Assets;@JM_s_Structures;@KJW_s_Two_Primary_Weapons;@Watershed_Division;@Scifi_Vehicles_Pack;@Helmet_on_Ass__Helmet_Slinging;@KAT__Advanced_Medical;@Task_Force_Timberwolf_Female_Characters;@Misriah_Armory_Project_ORION;@3den_Edit_Freefall_Modules;@Enhanced_Movement;@Dismount_Loop__Run_Over_Prevention_System;@Incoming_Transmission;@Incoming_Transmission__Pings;@Zulu_Headless_Client_ZHC_;@Archie_Summer;@Maksniemi;@Stubbhult;@Drakovac;@WebKnight_s_OPTRE_Expansion;@White_Team_Aux;@UNSC_Naval_Special_Weapons;@Freefall_Fix;@Zeus_Enhanced_Targeting_ZET___v1_2_Custom_Filters_;@_C21_Jiralhanae_WIP;@UNSC_Infirmary;',
    serverMods: '@Zulu_Headless_Client_ZHC_;',
    extraArgs: '-enableHT -autoInit'
  },
  // Add more servers here (server2, server3, ...) with their own IDs and commands.
];

function buildServerCommand(server) {
  const exe = ARMA3_PATH
    ? path.join(ARMA3_PATH, 'arma3server_x64.exe')
    : 'arma3server_x64.exe';

  const profileRoot = path.join(ARMA3_SERVERS_ROOT, server.profileId);
  const configPath = path.join(profileRoot, 'server_config.cfg');
  const basicPath = path.join(profileRoot, 'server_basic.cfg');

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

// Track running processes by server ID

const running = new Map();

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

  const info = {
    process: child,
    status: 'starting',
    startedAt: new Date()
  };

  running.set(id, info);

  child.stdout.on('data', (data) => {
    console.log(`[${id}] ${data}`);
    info.status = 'running';
  });

  child.stderr.on('data', (data) => {
    console.error(`[${id} ERROR] ${data}`);
  });

  child.on('exit', (code, signal) => {
    console.log(`Server ${id} exited with code ${code}, signal ${signal}`);
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

  running.delete(id);
  return { ok: true, message: 'Stop command issued' };
}

// API routes - servers
app.get('/api/servers', (req, res) => {
  const list = servers.map((s) => ({
    id: s.id,
    name: s.name,
    status: getStatus(s.id)
  }));
  res.json(list);
});

app.post('/api/servers/:id/start', (req, res) => {
  const id = req.params.id;
  const result = startServer(id);
  res.status(result.ok ? 200 : 400).json(result);
});

app.post('/api/servers/:id/stop', (req, res) => {
  const id = req.params.id;
  const result = stopServer(id);
  res.status(result.ok ? 200 : 400).json(result);
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

    app.post('/api/missions/upload', upload.single('mission'), (req, res) => {
      if (!req.file) {
        return res
          .status(400)
          .json({ ok: false, message: 'No file uploaded (field name: mission)' });
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
