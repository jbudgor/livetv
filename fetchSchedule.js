const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const EPG_URLS = [
  'https://raw.githubusercontent.com/acidjesuz/EPGTalk/master/US_guide.xml.gz',
  'https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz'
];

const STATION_ALIASES = {
  'A&E USA': ['a&e', 'a&e network', 'aand e', 'ae', 'a & e', 'a&e channel'],
  'HGTV': [
    'i229.14902.schedulesdirect.org',
    'i229.49788.schedulesdirect.org',
    'hgtv',
    'hgtvusa',
    'hgtveast',
    'hgtvhd',
    'home & garden television'
  ],
  'TCM USA': ['tcm', 'turner classic movies', 'tcm us'],
  'TMC Channel USA': ['the movie channel', 'tmc', 'tmc us', 'the movie channel east'],
  'USA Network': ['usa network', 'usa us', 'usa', 'usa east', 'usa hd'],
  'ABC USA': ['abc', 'abc us', 'abc network'],
  'CBS USA': ['cbs', 'cbs us', 'cbs network'],
  'NBC USA': ['nbc', 'nbc us', 'nbc network'],
  'FOX USA': ['fox', 'fox us', 'fox network'],
  'CW USA': ['cw', 'the cw', 'cw us'],
  'PBS USA': ['pbs', 'pbs us'],
  'FX USA': ['fx', 'fx us'],
  'Fox Sports 1 USA': ['fs1', 'fox sports 1', 'fox sports 1 us'],
  'Showtime USA': ['showtime', 'showtime us', 'sho']
};

function getTimeSlots() {
  const now = new Date();
  const minutes = now.getMinutes();
  const roundedMinutes = minutes < 30 ? 0 : 30;
  const currentBlock = new Date(now);
  currentBlock.setMinutes(roundedMinutes, 0, 0);

  const offsets = [0, 30, 60];
  
  return offsets.map(offset => {
    const slotTime = new Date(currentBlock.getTime() + offset * 60000);
    const timeString = slotTime.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
    return {
      offset,
      label: timeString,
      timestamp: slotTime.getTime()
    };
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchText(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }

      const isGzip = url.endsWith('.gz') || res.headers['content-encoding'] === 'gzip';
      const stream = isGzip ? res.pipe(zlib.createGunzip()) : res;

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(25000, () => {
      req.destroy();
      reject(new Error('Timeout fetching ' + url));
    });
  });
}

function cleanName(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/\b(usa|us|ca|hd|east|west)\b/gi, '')
    .replace(/[^a-z0-9]/g, '');
}

function parseXmlDate(str) {
  if (!str || str.length < 14) return 0;
  const y = str.slice(0, 4);
  const m = str.slice(4, 6) - 1;
  const d = str.slice(6, 8);
  const h = str.slice(8, 10);
  const min = str.slice(10, 12);
  const s = str.slice(12, 14);
  return new Date(Date.UTC(y, m, d, h, min, s)).getTime();
}

function parseXmlGuide(xmlText) {
  const channelDisplayNames = {};
  
  const channelRegex = /<channel[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g;
  let chanMatch;
  while ((chanMatch = channelRegex.exec(xmlText)) !== null) {
    const id = chanMatch[1];
    const body = chanMatch[2];
    
    const names = [id, cleanName(id), id.toLowerCase()];

    const nameRegex = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let nameMatch;
    while ((nameMatch = nameRegex.exec(body)) !== null) {
      const rawName = nameMatch[1].trim();
      names.push(rawName, cleanName(rawName), rawName.toLowerCase());
    }
    channelDisplayNames[id] = Array.from(new Set(names.filter(Boolean)));
  }

  const programMap = {};
  const progRegex = /<programme[^>]*channel="([^"]+)"[^>]*start="([^"]+)"[^>]*stop="([^"]+)"[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/g;
  
  let progMatch;
  while ((progMatch = progRegex.exec(xmlText)) !== null) {
    const chanId = progMatch[1];
    const start = parseXmlDate(progMatch[2]);
    const stop = parseXmlDate(progMatch[3]);
    const title = progMatch[4].replace(/<!\[CDATA\[|\]\]>/g, '').trim();

    const names = [chanId, ...(channelDisplayNames[chanId] || [])];
    
    names.forEach(name => {
      const cleaned = cleanName(name);
      const rawLower = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      
      [name, cleaned, rawLower].forEach(key => {
        if (!key) return;
        if (!programMap[key]) programMap[key] = [];
        programMap[key].push({ start, stop, title });
      });
    });
  }

  return programMap;
}

async function run() {
  const mappingPath = path.join(__dirname, '../data/dlhd_mapping.json');
  const outputPath = path.join(__dirname, '../public/schedule.js');

  if (!fs.existsSync(mappingPath)) {
    console.error('Error: data/dlhd_mapping.json not found.');
    process.exit(1);
  }

  const dlhdMap = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  const targetStations = Object.keys(dlhdMap);
  const slots = getTimeSlots();

  console.log('1/2 Fetching EPG guide XML files...');
  const combinedPrograms = {};

  for (let i = 0; i < EPG_URLS.length; i++) {
    const url = EPG_URLS[i];
    try {
      console.log('  [' + (i + 1) + '/' + EPG_URLS.length + '] Downloading ' + url.split('/').pop() + '...');
      const xmlData = await fetchText(url);
      console.log('  Successfully unpacked ' + (xmlData.length / 1024 / 1024).toFixed(2) + ' MB of guide data.');
      
      const progMap = parseXmlGuide(xmlData);
      Object.keys(progMap).forEach(key => {
        if (!combinedPrograms[key]) combinedPrograms[key] = [];
        combinedPrograms[key].push(...progMap[key]);
      });
    } catch (e) {
      console.warn('  Warning: Failed to fetch source ' + (i + 1) + ':', e.message);
    }
  }

  console.log('2/2 Mapping stations to active programs...');
  const schedule = {};
  let populatedCount = 0;
  const unmapped = [];

  const availableKeys = Object.keys(combinedPrograms);

  targetStations.forEach(station => {
    const stationData = dlhdMap[station];
    const targetClean = cleanName(station);
    const targetRawLower = station.toLowerCase().replace(/[^a-z0-9]/g, '');

    let matchKey = null;

    const aliases = STATION_ALIASES[station] || [];
    for (const alias of aliases) {
      const aliasClean = cleanName(alias);
      const aliasLower = alias.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (combinedPrograms[alias] && combinedPrograms[alias].length > 0) {
        matchKey = alias;
        break;
      }
      if (combinedPrograms[aliasClean] && combinedPrograms[aliasClean].length > 0) {
        matchKey = aliasClean;
        break;
      }
      if (combinedPrograms[aliasLower] && combinedPrograms[aliasLower].length > 0) {
        matchKey = aliasLower;
        break;
      }

      const foundAliasKey = availableKeys.find(k => k.includes(aliasClean) || aliasClean.includes(k));
      if (foundAliasKey && combinedPrograms[foundAliasKey].length > 0) {
        matchKey = foundAliasKey;
        break;
      }
    }

    if (!matchKey && combinedPrograms[station]) {
      matchKey = station;
    }

    if (!matchKey) {
      matchKey = availableKeys.find(k => k === targetClean || k === targetRawLower);
    }

    if (!matchKey) {
      matchKey = availableKeys.find(k => {
        if (!k || !targetClean) return false;
        return (k.length > 2 && targetClean.includes(k)) || 
               (targetClean.length > 2 && k.includes(targetClean));
      });
    }

    const progs = matchKey ? combinedPrograms[matchKey] : [];
    if (progs.length > 0) {
      populatedCount++;
    } else {
      unmapped.push(station);
    }

    schedule[station] = {
      dlhdId: stationData.dlhdId,
      url: stationData.url,
      slots: slots.map(slot => {
        const progMatch = progs.find(p => slot.timestamp >= p.start && slot.timestamp < p.stop);
        return {
          label: slot.label,
          program: progMatch ? progMatch.title : 'Live Broadcast (' + station + ')'
        };
      })
    };
  });

  console.log('Successfully mapped live programs for ' + populatedCount + '/' + targetStations.length + ' stations.');
  
  if (unmapped.length > 0) {
    console.log('\nUnmapped stations (' + unmapped.length + '):');
    console.log(unmapped.join(', '));
  }

  const finalData = {
    generatedAt: new Date().toISOString(),
    timeSlots: slots.map(s => s.label),
    stations: schedule
  };

  const fileContent = 'window.SCHEDULE_DATA = ' + JSON.stringify(finalData, null, 2) + ';';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, fileContent);
  console.log('\nSchedule successfully generated at ' + outputPath);

  process.exit(0);
}

run();