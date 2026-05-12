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
    apiKey:      process.env.RAGIC_API_KEY      || '',
    accountName: process.env.RAGIC_ACCOUNT      || 'weibyapps',
    sheetPath:   process.env.RAGIC_SHEET_PATH   || '/forms4/7',
    dealerField: process.env.RAGIC_DEALER_FIELD || '負責業務',
    dateField:   process.env.RAGIC_DATE_FIELD   || '安裝/結案日',
    server:      process.env.RAGIC_SERVER        || 'ap5',  // 你們是 ap5
  },
  // Asana assignee 全名 → 儀表板名稱
  // 用包含比對，所以只要名字含這些字就會對應
  nameMap: {
    // Asana（包含比對）
    'Harry':  'Harry',
    'jack':   'Jack',
    'Wei':    'Wei',
    'Johnny': 'Johnny',
    'Jason':  'Jason',
    // Ragic（中文全名）
    '微碧北區業務-黃柏皓': 'Harry',
    '微碧北區業務-黃建銘': 'Jack',
    '微碧北區業務-陳威旼': 'Wei',
    '微碧桃區業務-趙子儀': 'Johnny',
    '微碧桃區業務-蔣宇倢': 'Jason',
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
  const url = `https://${CFG.ragic.server}.ragic.com/${accountName}${sheetPath}?api&v=3&APIKey=${apiKey}&limit=-1`;
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

// ── 分配儀表板資料 ──────────────────────────────────────
// 追蹤中的 Section（不含結案）
const TRACKING_SECTIONS = new Set([
  '待介紹','待線上介紹','介紹完考慮中-可能性高','介紹完考慮中-可能性低',
  '機會高-需要時間等待','待裝機'
]);
const DEAL_SECTION = '裝機完成結案';
const HALF_YEAR_MS = 180 * 24 * 60 * 60 * 1000;
const OVERDUE_DAYS = 14; // 超過幾天算逾期

async function fetchStories(taskId, token) {
  // 拿 task 的留言，找最新一則 comment 的時間
  try {
    const url = `https://app.asana.com/api/1.0/tasks/${taskId}/stories?opt_fields=type,created_at&limit=100`;
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    const comments = (res.data || []).filter(s => s.type === 'comment');
    if (comments.length === 0) return null;
    // 最新留言時間
    return comments[comments.length - 1].created_at;
  } catch(e) {
    return null;
  }
}

async function fetchAllocProject(token, projectId, nameMap) {
  const secUrl = `https://app.asana.com/api/1.0/projects/${projectId}/sections?opt_fields=name`;
  const secRes = await fetchJson(secUrl, { Authorization: `Bearer ${token}` });
  const sections = secRes.data || [];
  const trackingSections = sections.filter(s => TRACKING_SECTIONS.has(s.name));
  const now = Date.now();
  const allTasks = [];
  // 撈裝機完成結案 section
  const dealSection = sections.find(s => s.name === DEAL_SECTION);
  let dealTasks = [];
  if (dealSection) {
    const durl = `https://app.asana.com/api/1.0/sections/${dealSection.gid}/tasks?opt_fields=name,assignee.name,due_on&limit=100`;
    const dres = await fetchJson(durl, { Authorization: `Bearer ${token}` });
    dealTasks = dres.data || [];
  }

  for (const sec of trackingSections) {
    const url = `https://app.asana.com/api/1.0/sections/${sec.gid}/tasks?opt_fields=completed,name,assignee.name,modified_at,created_at,due_on&limit=100`
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    const tasks = (res.data || []).filter(t => !t.completed).map(t => ({ ...t, sectionName: sec.name }));
    allTasks.push(...tasks);
    console.log(`  Section「${sec.name}」：${tasks.length} 筆`);
  }

  // 候選逾期 task（modified_at > 10天）批次查留言，最多 80 筆
  const candidates = allTasks
    .filter(t => Math.floor((now - new Date(t.modified_at || t.created_at).getTime()) / 86400000) >= 10)
    .slice(0, 80);

  const lastCommentMap = {};
  for (let i = 0; i < candidates.length; i += 5) {
    const batch = candidates.slice(i, i + 5);
    await Promise.all(batch.map(async t => {
      try {
        const url = `https://app.asana.com/api/1.0/tasks/${t.gid}/stories?opt_fields=type,created_at&limit=100`;
        const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
        const comments = (res.data || []).filter(s => s.type === 'comment');
        if (comments.length > 0) lastCommentMap[t.gid] = comments[comments.length - 1].created_at;
      } catch(e) {}
    }));
  }

  const result = {};
  for (const task of allTasks) {
    const rawName = task.assignee?.name;
    if (!rawName) continue;
    const name = nameMap[rawName]
      || Object.entries(nameMap).find(([k]) => rawName.includes(k))?.[1]
      || rawName;

    if (!result[name]) result[name] = { tracking: [], overdue: [] };

    const lastStr = lastCommentMap[task.gid] || task.modified_at || task.created_at;
    const daysSince = Math.floor((now - new Date(lastStr).getTime()) / 86400000);
    const taskInfo = {
      gid: task.gid,
      id: task.name?.split('/')[0]?.trim() || task.gid,
      name: task.name || '',
      section: task.sectionName,
      daysSince,
    };
    result[name].tracking.push(taskInfo);
    if (daysSince >= OVERDUE_DAYS) result[name].overdue.push(taskInfo);
  }
return { result, dealTasks };
}

async function fetchAlloc() {
  const { token, projectIds } = CFG.asana;
  if (!token) { console.warn('⚠️  Asana 未設定，跳過分配資料'); return {}; }

  console.log('📥 撈取分配儀表板資料...');
  const nameMap = CFG.nameMap;

  // 同時撈兩個 project
  const results = await Promise.all(
  projectIds.map(id => fetchAllocProject(token, id, nameMap))
);

const allDealTasks = results.flatMap(r => r.dealTasks);
const merged = {};
results.forEach(r => {
  Object.entries(r.result).forEach(([name, data]) => {
      if (!merged[name]) merged[name] = { tracking: [], overdue: [] };
      merged[name].tracking.push(...data.tracking);
      merged[name].overdue.push(...data.overdue);
    });
  });

  // 整理成分配儀表板需要的格式
  const now = Date.now();
const halfYearAgo = now - HALF_YEAR_MS;
  const final = {};
  Object.entries(merged).forEach(([name, data]) => {
    // 狀態統計
    const statusCount = {};
    data.tracking.forEach(t => {
      statusCount[t.section] = (statusCount[t.section] || 0) + 1;
    });

    // 逾期列表（最多顯示 10 筆，依天數降序）
    const overdueList = data.overdue
      .sort((a, b) => b.daysSince - a.daysSince)
      .slice(0, 10)
      .map(t => ({
        id: t.id,
        loc: t.name.slice(0, 30),
        days: t.daysSince,
        status: t.section,
      }));

    const makeList = (section) => data.tracking
  .filter(t => t.section === section)
  .sort((a,b) => b.daysSince - a.daysSince)
  .slice(0, 10)
  .map(t => ({ id: t.id, loc: t.name.slice(0, 30), days: t.daysSince, url: `https://app.asana.com/0/${t.gid}/${t.gid}` }));
    const hqKw = CFG.asana.hqKeywords;
    const thisMonthStart = new Date();
thisMonthStart.setDate(1);
thisMonthStart.setHours(0,0,0,0);

const thisMonth = data.tracking.filter(t => {
  if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
  return new Date(t.created_at||0).getTime() >= thisMonthStart.getTime();
}).length;

    const visitCount = data.tracking.filter(t => {
      if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
      return new Date(t.created_at||0).getTime() >= halfYearAgo;
    }).length;

    const dealCount = allDealTasks.filter(t => {
      const rawName = t.assignee?.name;
      if (!rawName) return false;
      const pName = nameMap[rawName] || Object.entries(nameMap).find(([k])=>rawName.includes(k))?.[1];
      if (pName !== name) return false;
      if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
      if (!t.due_on) return false;
      const due = new Date(t.due_on).getTime();
      return due >= halfYearAgo && due <= now;
    }).length;

    const dealRate = visitCount > 0 ? Math.round(dealCount / visitCount * 1000) / 10 : null;
    final[name] = {
      thisMonth,
      tracking: data.tracking.length,
      overdue: data.overdue.length,
      statusCount,
      overdueList,
      possibleHighList: makeList('介紹完考慮中-可能性高'),
      timeNeededList:   makeList('機會高-需要時間等待'),
      possibleLowList:  makeList('介紹完考慮中-可能性低'),
      introList:        makeList('待介紹'),
      visitCount,
      dealCount,
      dealRate,
    };
  });

  console.log('✅ 分配資料完成，業務：', Object.keys(final).join(', '));
  return final;
}

// ── 主程式 ─────────────────────────────────────────────
async function main() {
  console.log('🚀 開始同步...\n');

  const [asana, ragic, alloc] = await Promise.allSettled([
    fetchAsana(), fetchRagic(), fetchAlloc()
  ]);

  const output = {
    syncTime: new Date().toISOString(),
    asana:    asana.status  === 'fulfilled' ? asana.value  : { _error: asana.reason?.message  },
    ragic:    ragic.status  === 'fulfilled' ? ragic.value  : { _error: ragic.reason?.message  },
    alloc:    alloc.status  === 'fulfilled' ? alloc.value  : { _error: alloc.reason?.message  },
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2), 'utf8');
  console.log('\n✅ data.json 已更新');
  console.log('   同步時間：', output.syncTime);

  if (output.asana._error) console.error('   ❌ Asana 錯誤：', output.asana._error);
  if (output.ragic._error) console.error('   ❌ Ragic 錯誤：',  output.ragic._error);
  if (output.alloc._error) console.error('   ❌ 分配資料錯誤：', output.alloc._error);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
