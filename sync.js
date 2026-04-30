const https = require('https');
const fs = require('fs');
const CFG = {
  asana: {
    token: process.env.ASANA_TOKEN || '',
    projectIds: [
      process.env.ASANA_PROJECT_ID_NORTH || '1184215025689649',
      process.env.ASANA_PROJECT_ID_TAOYUAN || '1201404566456110',
    ],
    hqKeywords: ['總部分店'],
  },
  ragic: {
    apiKey: process.env.RAGIC_API_KEY || '',
    accountName: process.env.RAGIC_ACCOUNT || 'weibyapps',
    sheetPath: process.env.RAGIC_SHEET_PATH || '/forms4/7',
    dealerField: process.env.RAGIC_DEALER_FIELD || '負責業務',
    dateField: process.env.RAGIC_DATE_FIELD || '安裝/結案日',
    server: process.env.RAGIC_SERVER || 'ap5',
  },
nameMap: {
    'Harry':  'Harry',
    'jack':   'Jack',
    'Wei':    'Wei',
    'Johnny': 'Johnny',
    'Jason':  'Jason',
'黃柏皓': 'Harry',
'黃建銘': 'Jack',
'陳威旼': 'Wei',
'趙子儀': 'Johnny',
'蔣宇倢': 'Jason',
  },
};
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: 'application/json', ...headers } }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(e) { reject(new Error('JSON parse error: ' + raw.slice(0, 300))); } });
    }).on('error', reject);
  });
}
function toMonthLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return (d.getMonth() + 1) + '月';
}
async function fetchAsanaProject(token, projectId) {
  let tasks = [], offset = '';
  while (true) {
    const url = `https://app.asana.com/api/1.0/projects/${projectId}/tasks?opt_fields=name,assignee.name,created_at&limit=100` + (offset ? `&offset=${offset}` : '');
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    if (res.errors) { console.error('Asana error:', JSON.stringify(res.errors)); break; }
    tasks = tasks.concat(res.data || []);
    console.log(`  Project ${projectId}：已取得 ${tasks.length} 筆`);
    if (res.next_page?.offset) { offset = res.next_page.offset; } else break;
  }
  return tasks;
}
async function fetchAsana() {
  const { token, projectIds, hqKeywords } = CFG.asana;
  if (!token || !projectIds?.length) { console.warn('Asana 未設定'); return {}; }
  console.log('撈取 Asana...');
  const allResults = await Promise.all(projectIds.map(id => fetchAsanaProject(token, id)));
  const tasks = allResults.flat();
  console.log(`共取得 ${tasks.length} 筆`);
  const result = {};
  for (const task of tasks) {
    const rawName = task.assignee?.name;
    if (!rawName) continue;
    const name = CFG.nameMap[rawName] || Object.entries(CFG.nameMap).find(([k]) => rawName.includes(k))?.[1] || rawName;
    const month = toMonthLabel(task.created_at);
    if (!month) continue;
    if (!result[name]) result[name] = {};
    if (!result[name][month]) result[name][month] = { visits: 0, hq: 0 };
    result[name][month].visits++;
    if (hqKeywords.some(kw => (task.name || '').includes(kw))) result[name][month].hq++;
  }
  console.log('Asana 完成：', Object.keys(result).join(', '));
  return result;
}
async function fetchRagic() {
  const { apiKey, accountName, sheetPath, dealerField, dateField } = CFG.ragic;
  if (!apiKey || !accountName || !sheetPath) { console.warn('Ragic 未設定'); return {}; }
  console.log('撈取 Ragic...');
  const url = `https://${CFG.ragic.server}.ragic.com/${accountName}${sheetPath}?api&v=3&APIKey=${apiKey}&limit=-1`;
  const res = await fetchJson(url);
 const entries = Object.entries(res).filter(([id, r]) => !id.startsWith('_') && r['負責業務']); if (entries.length > 0) { console.log('Ragic有業務的筆:', JSON.stringify(entries[0][1]).slice(0, 800)); } else { console.log('找不到負責業務欄位，keys:', Object.keys(Object.values(res)[0] || {}).join(',')); }
  const result = {};
  for (const [id, record] of Object.entries(res)) {
    if (id.startsWith('_')) continue;
    const rawName = record[dealerField];
    const dateStr = record[dateField];
    if (!rawName || !dateStr) continue;
    const name = CFG.nameMap[rawName] || Object.entries(CFG.nameMap).find(([k]) => rawName.includes(k))?.[1] || rawName;
    const month = toMonthLabel(dateStr);
    if (!month) continue;
    if (!result[name]) result[name] = {};
    result[name][month] = (result[name][month] || 0) + 1;
  }
  console.log('Ragic 完成：', Object.keys(result).join(', '));
  return result;
}
async function main() {
  const [asana, ragic] = await Promise.allSettled([fetchAsana(), fetchRagic()]);
  const output = {
    syncTime: new Date().toISOString(),
    asana: asana.status === 'fulfilled' ? asana.value : { _error: asana.reason?.message },
    ragic: ragic.status === 'fulfilled' ? ragic.value : { _error: ragic.reason?.message },
  };
  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf8');
  console.log('data.json 已更新，時間：', output.syncTime);
}
main().catch(e => { console.error('Fatal:', e); process.exit(1); });
