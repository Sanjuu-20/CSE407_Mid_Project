const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const TuyAPI = require('tuyapi');

const app = express();
const PORT = process.env.PORT || 3000;

const CONFIG_FILE = path.join(__dirname, 'device_config.json');
const DATA_FILE = path.join(__dirname, 'device_data.json');

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

let deviceConfig = null;
let device = null;
let connected = false;
let lastKnownDps = {};
let readingsLog = [];
let latestReadings = {
  watt: 0,
  current: 0,
  voltage: 0,
  power_on: false,
  connected: false,
  timestamp: new Date().toISOString()
};

/**
 * Load device configuration and historical readings from disk
 */
function loadData() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      deviceConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      console.log(`Loaded device configuration`);
    } catch (err) {
      console.error('Failed to load device configuration:', err);
      deviceConfig = null;
    }
  }

  if (fs.existsSync(DATA_FILE)) {
    try {
      readingsLog = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      console.log(`Loaded ${readingsLog.length} historical readings`);
    } catch (err) {
      console.error('Failed to load historical data:', err);
      readingsLog = [];
    }
  }
}

/**
 * Persist readings and configuration to disk
 */
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(readingsLog, null, 2));
  } catch (err) {
    console.error('Failed to save readings:', err);
  }

  if (deviceConfig) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(deviceConfig, null, 2));
    } catch (err) {
      console.error('Failed to save device configuration:', err);
    }
  }
}

/**
 * Initialize or re-initialize the Tuya device instance
 */
function initializeDevice() {
  if (!deviceConfig) return;

  if (device) {
    try {
      device.disconnect();
    } catch (_) {}
  }

  device = new TuyAPI({
    id: deviceConfig.id,
    key: deviceConfig.key,
    ip: deviceConfig.ip,
    version: deviceConfig.version,
    issueRefreshOnConnect: true,
    issueGetOnConnect: true
  });

  device.on('connected', () => {
    connected = true;
    latestReadings.connected = true;
    console.log('Device connected');
  });

  device.on('disconnected', () => {
    connected = false;
    latestReadings.connected = false;
    console.warn('Device disconnected');
  });

  device.on('error', (err) => {
    connected = false;
    latestReadings.connected = false;
    console.error('Device error:', err.message);
  });

  device.on('data', (data) => {
    if (data && data.dps) {
      lastKnownDps = { ...lastKnownDps, ...data.dps };
      updateReadingsFromDps();
    }
  });

  device.on('dp-refresh', (data) => {
    if (data && data.dps) {
      lastKnownDps = { ...lastKnownDps, ...data.dps };
      updateReadingsFromDps();
    }
  });
}

/**
 * Attempt to connect to the device
 */
async function connectToDevice() {
  if (!device) return;

  try {
    await device.find({ timeout: 10000 });
    await device.connect();
  } catch (err) {
    connected = false;
    latestReadings.connected = false;
    console.error('Connection attempt failed:', err.message);
  }
}

/**
 * Update latestReadings based on lastKnownDps
 */
function updateReadingsFromDps() {
  const powerOn = lastKnownDps['1'] === true;
  const rawVolt = lastKnownDps['20'] || 0;
  const rawWatt = lastKnownDps['19'] || 0;
  const rawCurr = lastKnownDps['18'] || 0;

  latestReadings = {
    watt: rawWatt / 10,
    current: rawCurr / 1000,
    voltage: rawVolt / 10,
    power_on: powerOn,
    connected: connected,
    timestamp: new Date().toISOString()
  };
}

/**
 * Store a data point if connected
 */
function storeDataPoint() {
  if (connected) {
    readingsLog.push(latestReadings);
    console.log(`Stored: ${latestReadings.watt}W, ${latestReadings.current}A, ${latestReadings.voltage}V`);
  }
}

/**
 * Filter readings by time range
 */
function getFilteredReadings(range, start, end) {
  const now = new Date();
  let fromDate = new Date(0);

  switch (range) {
    case 'hour': fromDate = new Date(now.getTime() - 60 * 60 * 1000); break;
    case '6hour': fromDate = new Date(now.getTime() - 6 * 60 * 60 * 1000); break;
    case '24hour': fromDate = new Date(now.getTime() - 24 * 60 * 60 * 1000); break;
    case 'week': fromDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
    case 'month': fromDate = new Date(now.setMonth(now.getMonth() - 1)); break;
    case 'year': fromDate = new Date(now.setFullYear(now.getFullYear() - 1)); break;
    case 'custom':
      fromDate = start ? new Date(start) : new Date(0);
      break;
  }

  const toDate = end ? new Date(end) : now;

  return readingsLog
    .filter(r => {
      const t = new Date(r.timestamp);
      return t >= fromDate && t <= toDate;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// API Endpoints

// Device configuration
app.get('/api/device', (req, res) => {
  if (!deviceConfig) {
    return res.status(404).json({ error: 'No device configured' });
  }
  res.json(deviceConfig);
});

app.post('/api/device', (req, res) => {
  if (deviceConfig) {
    return res.status(400).json({ error: 'Device already configured' });
  }
  const { id, key, ip, version } = req.body;
  if (!id || !key || !ip || !version) {
    return res.status(400).json({ error: 'Missing device parameters' });
  }
  deviceConfig = { id, key, ip, version };
  saveData();
  initializeDevice();
  res.json({ success: true, device: deviceConfig });
});

app.delete('/api/device', (req, res) => {
  if (!deviceConfig) {
    return res.status(404).json({ error: 'No device to remove' });
  }
  deviceConfig = null;
  if (device) {
    device.disconnect();
    device = null;
  }
  fs.unlinkSync(CONFIG_FILE);
  res.json({ success: true });
});

// Device status
app.get('/api/status', (req, res) => {
  res.json({
    connected,
    ...latestReadings
  });
});

// Toggle power
app.post('/api/toggle', async (req, res) => {
  if (!connected || !device) {
    return res.status(503).json({ success: false, error: 'Device not connected' });
  }
  try {
    const newState = !latestReadings.power_on;
    await device.set({ dps: 1, set: newState });
    setTimeout(() => device.refresh(), 1000);
    res.json({ success: true, power_on: newState });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Readings and energy data
app.get('/api/data', (req, res) => {
  const { range, start, end } = req.query;
  res.json(getFilteredReadings(range, start, end));
});

app.get('/api/energy', (req, res) => {
  const { range, start, end } = req.query;
  const readings = getFilteredReadings(range, start, end);
  let energy = 0;

  for (let i = 1; i < readings.length; i++) {
    const prev = new Date(readings[i - 1].timestamp);
    const curr = new Date(readings[i].timestamp);
    const dtHours = (curr - prev) / 1000 / 3600;
    const avgWatts = ((readings[i - 1].watt) + (readings[i].watt)) / 2;
    energy += avgWatts * dtHours;
  }

  res.json({ energy_kwh: parseFloat((energy / 1000).toFixed(3)), readings_count: readings.length });
});

/**
 * Main startup and intervals
 */
function startup() {
  loadData();
  if (deviceConfig) {
    initializeDevice();
  }

  // Check connection every 5 seconds
  setInterval(async () => {
    if (deviceConfig) {
      if (!connected) {
        if (!device) initializeDevice();
        await connectToDevice();
      } else {
        device.refresh();
      }
    }
  }, 5000);

  // Store data every 60 seconds if connected
  setInterval(storeDataPoint, 60000);

  // Persist data every 60 seconds
  setInterval(saveData, 60000);
}

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  startup();
});
