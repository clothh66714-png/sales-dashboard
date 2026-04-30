/**
 * sync.js — 由 GitHub Actions 每天執行
 * 從 Asana 和 Ragic 撈資料，產生 data.json
 */

const https = require('https');
const fs = require('fs');

// ── 設定（從 GitHub Secrets 讀取）─────────────────────
const CFG = {
  asana: {
    token:      process.env.ASANA_TOKEN || '',
    // 兩個 Project：北部客戶清單 + 桃園客戶清單
    projectIds: [
      process.env.ASANA_PROJECT_ID_NORTH || '1184215025689649',  // 北部客戶清單
      process.env.ASANA_PROJECT_ID_TAOYUAN || '1201404566456110', // 桃園客戶清單
    ],
    // 任務名稱包含此字串就判定為「總部分店」（計入 hq 扣除數）
    hqKeywords: ['總部分店'],
  },
  ragic: {
    apiKey:      process.env.RAGIC_API_KEY  || '',
    accountName: process.env.RAGIC_ACCOUNT  || 'weibyapps',
    sheetPath:   process.env.RAGIC_SHEET_PATH || '/forms4/7',
    dealerField: process.env.RAGIC_DEALER_FIELD || '負責業務',
    dateField:   process.env.RAGIC_DATE_FIELD   || '安裝/結案日',
    server:      process.env.RAGIC_SERVER       || 'ap5',
  },
  // Asana assignee 全名 → 儀表板名稱
  // 請依實際情況修改（Asana 顯示的是完整名字）
 nameMap: {
    'Harry / Sales':  'Harry',
    'Wei/Sales':      'Wei',
    'jack/Sales':     'Jack',
    'Johnny / Sales': 'Johnny',
    'Jason/Sales':    'Jason',
  },
  },
};

// ── HTTP helper ────────────────────────────────────────
function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { Accept: 'application/json', ...headers },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { reject(new Error('JSON parse error: ' + raw.slice(0, 300))); }
      });
    }).on('error', reject);
  });
}

// ── 月份工具 ───────────────────────────────────────────
function toMonthLabel(dateStr) {
  // 支援 YYYY-MM-DD 或 YYYY/MM/DD 或 ISO 格式
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  return (d.getMonth() + 1) + '月';
}

// ── Asana 來客資料 ─────────────────────────────────────
async function fetchAsanaProject(token, projectId) {
  let tasks = [], offset = '';
  while (true) {
    const url = `https://app.asana.com/api/1.0/projects/${projectId}/tasks`
      + `?opt_fields=name,assignee.name,created_at&limit=100`
      + (offset ? `&offset=${offset}` : '');
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    if (res.errors) { console.error('Asana API 錯誤：', JSON.stringify(res.errors)); break; }
    tasks = tasks.concat(res.data || []);
    console.log(`  Project ${projectId}：已取得 ${tasks.length} 筆`);
    if (res.next_page?.offset) { offset = res.next_page.offset; } else break;
  }
  return tasks;
}

async function fetchAsana() {
  const { token, projectIds, hqKeywords } = CFG.asana;
  if (!token || !projectIds?.length) {
    console.warn('⚠️  Asana 未設定，跳過');
    return {};
  }

  console.log('📥 撈取 Asana 資料（共', projectIds.length, '個 Project）...');

  // 同時撈所有 Project
  const allResults = await Promise.all(projectIds.map(id => fetchAsanaProject(token, id)));
  let tasks = allResults.flat();
  console.log(`  共取得 ${tasks.length} 筆任務`);

  // 統計：result[personName][monthLabel] = { visits, hq }
  const result = {};

  for (const task of tasks) {
    const rawName = task.assignee?.name;
    if (!rawName) continue;

    // 對應人名（完全符合或包含）
    const name = CFG.nameMap[rawName]
      || Object.entries(CFG.nameMap).find(([k]) => rawName.includes(k))?.[1]
      || rawName;

    const month = toMonthLabel(task.created_at);
    if (!month) continue;

    if (!result[name]) result[name] = {};
    if (!result[name][month]) result[name][month] = { visits: 0, hq: 0 };

    result[name][month].visits++;

    const isHq = hqKeywords.some(kw => (task.name || '').includes(kw));
    if (isHq) result[name][month].hq++;
  }

  console.log('✅ Asana 完成，業務：', Object.keys(result).join(', '));
  return result;
}

// ── Ragic 成交資料 ─────────────────────────────────────
async function fetchRagic() {
  const { apiKey, accountName, sheetPath, dealerField, dateField } = CFG.ragic;
  if (!apiKey || !accountName || !sheetPath) {
    console.warn('⚠️  Ragic 未設定，跳過');
    return {};
  }

  console.log('📥 撈取 Ragic 資料...');
  const url = `https://ap7.ragic.com/${accountName}${sheetPath}?api&v=3&APIKey=${apiKey}&limit=-1`;
  const res = await fetchJson(url);

  // result[personName][monthLabel] = dealCount
  const result = {};

  for (const [id, record] of Object.entries(res)) {
    if (id.startsWith('_')) continue;

    const rawName = record[dealerField];
    const dateStr = record[dateField];
    if (!rawName || !dateStr) continue;

    const name = CFG.nameMap[rawName]
      || Object.entries(CFG.nameMap).find(([k]) => rawName.includes(k))?.[1]
      || rawName;

    const month = toMonthLabel(dateStr);
    if (!month) continue;

    if (!result[name]) result[name] = {};
    result[name][month] = (result[name][month] || 0) + 1;
  }

  console.log('✅ Ragic 完成，業務：', Object.keys(result).join(', '));
  return result;
}

// ── 主程式 ─────────────────────────────────────────────
async function main() {
  console.log('🚀 開始同步...\n');

  const [asana, ragic] = await Promise.allSettled([fetchAsana(), fetchRagic()]);

  const output = {
    syncTime: new Date().toISOString(),
    asana:    asana.status  === 'fulfilled' ? asana.value  : { _error: asana.reason?.message  },
    ragic:    ragic.status  === 'fulfilled' ? ragic.value  : { _error: ragic.reason?.message  },
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf8');
  console.log('\n✅ data.json 已更新');
  console.log('   同步時間：', output.syncTime);

  if (output.asana._error) console.error('   ❌ Asana 錯誤：', output.asana._error);
  if (output.ragic._error) console.error('   ❌ Ragic 錯誤：',  output.ragic._error);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
