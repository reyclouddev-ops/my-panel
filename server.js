import express from 'express';
import fileUpload from 'express-fileupload';
import fs from 'fs';
import path from 'path';
import { spawn, exec } from 'child_process';

const app = express();
const PORT = 3000;
const ROOT_DIR = path.resolve('.');

const servers = {};
let globalTerminalLogs = 'ReyCloud Daemon siap menerima perintah...\n';

app.use(fileUpload());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

// ==========================================
// API: SERVER & INSTANCE MANAGEMENT
// ==========================================
app.get('/api/servers', (req, res) => {
  const folders = fs.readdirSync(ROOT_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && !['node_modules', '.git', 'public', '.npm'].includes(dirent.name))
    .map(dirent => dirent.name);

  const serverList = folders.map(folder => ({
    name: folder,
    running: servers[folder]?.running || false,
    logs: servers[folder]?.logs || 'Server belum dijalankan...\n'
  }));

  res.json({ servers: serverList, terminalLogs: globalTerminalLogs });
});

app.post('/api/servers/create', (req, res) => {
  const name = req.body.servername?.trim().replace(/[^a-zA-Z0-9-_]/g, '');
  if (!name) return res.status(400).json({ success: false, message: 'Nama tidak valid!' });

  const dir = path.join(ROOT_DIR, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const randomPort = Math.floor(Math.random() * (9000 - 3001 + 1)) + 3001;
    
    fs.writeFileSync(path.join(dir, 'index.js'), `
const express = require('express');
const app = express();
const PORT = process.env.PORT || ${randomPort};

app.get('/', (req, res) => {
  res.json({ status: true, message: "Halo dari instance ${name}!", port: PORT });
});

app.listen(PORT, () => console.log('Instance ${name} aktif di port ' + PORT));
    `.trim());

    fs.writeFileSync(path.join(dir, '.env'), `PORT=${randomPort}\nDOMAIN=api-${name}.reycode.my.id\nNODE_VERSION=node`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: name,
      version: "1.0.0",
      main: "index.js",
      dependencies: { express: "^4.19.2" }
    }, null, 2));
  }
  res.json({ success: true });
});

app.post('/api/servers/start', (req, res) => {
  const { name } = req.body;
  const dir = path.join(ROOT_DIR, name);
  if (!fs.existsSync(dir) || servers[name]?.running) return res.json({ success: true });

  servers[name] = { running: true, logs: `[INFO] Menyalakan instance ${name}...\n`, process: null };
  const child = spawn('node', ['index.js'], { cwd: dir });

  child.stdout.on('data', (data) => {
    servers[name].logs += data.toString();
    if (servers[name].logs.length > 5000) servers[name].logs = servers[name].logs.slice(-5000);
  });
  child.stderr.on('data', (data) => servers[name].logs += `[ERROR] ${data.toString()}`);
  child.on('close', (code) => {
    servers[name].logs += `\n[INFO] Instance berhenti (kode ${code})\n`;
    servers[name].running = false;
  });

  servers[name].process = child;
  res.json({ success: true });
});

app.post('/api/servers/stop', (req, res) => {
  const { name } = req.body;
  if (servers[name]?.process) {
    servers[name].process.kill();
    servers[name].running = false;
  }
  res.json({ success: true });
});

app.post('/api/servers/restart', (req, res) => {
  const { name } = req.body;
  if (servers[name]?.process) {
    servers[name].process.kill();
    servers[name].running = false;
  }
  setTimeout(() => {
    const dir = path.join(ROOT_DIR, name);
    servers[name] = { running: true, logs: `[INFO] Merestart instance ${name}...\n`, process: null };
    const child = spawn('node', ['index.js'], { cwd: dir });
    child.stdout.on('data', (data) => servers[name].logs += data.toString());
    child.stderr.on('data', (data) => servers[name].logs += `[ERROR] ${data.toString()}`);
    child.on('close', (code) => {
      servers[name].logs += `\n[INFO] Instance berhenti (kode ${code})\n`;
      servers[name].running = false;
    });
    servers[name].process = child;
    res.json({ success: true });
  }, 600);
});

// ==========================================
// API: TERMINAL COMMAND EXECUTOR
// ==========================================
app.post('/api/terminal/run', (req, res) => {
  const { command, folder } = req.body;
  const targetDir = folder ? path.join(ROOT_DIR, folder) : ROOT_DIR;

  globalTerminalLogs += `\n$ [${folder || 'root'}] ${command}\n`;

  exec(command, { cwd: targetDir }, (error, stdout, stderr) => {
    if (stdout) globalTerminalLogs += stdout;
    if (stderr) globalTerminalLogs += stderr;
    if (error) globalTerminalLogs += `[ERROR] ${error.message}\n`;
    res.json({ success: true, logs: globalTerminalLogs });
  });
});

// ==========================================
// API: FILE & CONFIG MANAGER
// ==========================================
app.get('/api/files', (req, res) => {
  const { folder } = req.query;
  const targetDir = path.join(ROOT_DIR, folder);
  if (!fs.existsSync(targetDir)) return res.status(404).json({ error: 'Not found' });

  const items = fs.readdirSync(targetDir, { withFileTypes: true }).map(item => ({
    name: item.name,
    isDirectory: item.isDirectory()
  }));
  res.json(items);
});

// UPLOAD DENGAN FITUR AUTO-EXTRACT ZIP
app.post('/api/files/upload', (req, res) => {
  if (!req.files || !req.files.file) return res.status(400).send('File tidak ada');
  const { folder } = req.body;
  const file = req.files.file;
  const targetDir = path.join(ROOT_DIR, folder);
  const targetPath = path.join(targetDir, file.name);

  file.mv(targetPath, (err) => {
    if (err) return res.status(500).send(err);

    // Jika file berformat .zip, langsung ekstrak otomatis dan hapus zip aslinya
    if (file.name.endsWith('.zip')) {
      exec(`unzip -o "${file.name}" && rm "${file.name}"`, { cwd: targetDir }, (error) => {
        if (error) console.log('Gagal ekstrak otomatis:', error);
        res.redirect(`/manage.html?folder=${folder}`);
      });
    } else {
      res.redirect(`/manage.html?folder=${folder}`);
    }
  });
});

app.post('/api/files/delete', (req, res) => {
  const { folder, filename } = req.body;
  const target = path.join(ROOT_DIR, folder, filename);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
  }
  res.json({ success: true });
});

app.get('/api/files/read', (req, res) => {
  const { folder, filename } = req.query;
  const target = path.join(ROOT_DIR, folder, filename);
  if (!fs.existsSync(target)) return res.status(404).send('File tidak ditemukan');
  res.send(fs.readFileSync(target, 'utf8'));
});

app.post('/api/files/save', (req, res) => {
  const { folder, filename, content } = req.body;
  fs.writeFileSync(path.join(ROOT_DIR, folder, filename), content, 'utf8');
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`[🟢] ReyCloud Master Daemon aktif di http://localhost:${PORT}`);
});
