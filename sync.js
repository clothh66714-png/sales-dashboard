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
    server:      process.env.RAGIC_SERVER        || 'ap5',
  },
  nameMap: {
    'Harry':  'Harry',
    'jack':   'Jack',
    'Wei':    'Wei',
    'Johnny': 'Johnny',
    'Jason':  'Jason',
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

function toMonthLabel(dateStr) {
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
  const allResults = await Promise.all(projectIds.map(id => fetchAsanaProject(token, id)));
  let tasks = allResults.flat();
  console.log(`  共取得 ${tasks.length} 筆任務`);
  const result = {};
  for (const task of tasks) {
    const rawName = task.assignee?.name;
    if (!rawName) continue;
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
const TRACKING_SECTIONS = new Set([
  '待介紹','待線上介紹','介紹完-可能性高','介紹完-可能性低',
  '機會高-需要時間等待','待裝機','裝機結案',
  '內勤追蹤-第一次☝️','內勤追蹤-第二次☝️☝️','未裝機 - 結案關閉'
]);
const DEAL_SECTION = '裝機結案';
const NON_OVERDUE_SECTIONS = new Set([
  '裝機結案','內勤追蹤-第一次☝️','內勤追蹤-第二次☝️☝️','未裝機 - 結案關閉'
]);
const HALF_YEAR_MS = 180 * 24 * 60 * 60 * 1000;
const OVERDUE_DAYS = 14;

async function fetchAllocProject(token, projectId, nameMap) {
  const secUrl = `https://app.asana.com/api/1.0/projects/${projectId}/sections?opt_fields=name`;
  const secRes = await fetchJson(secUrl, { Authorization: `Bearer ${token}` });
  const sections = secRes.data || [];
  console.log('  Sections:', sections.map(s => s.name).join(' | '));

  // 撈整個 Project 的所有任務（含已完成）─ 用 completed_since=now 才能拿到已完成
  let allProjectTasks = [];
  let ptOffset = '';
  while (true) {
    const ptUrl = `https://app.asana.com/api/1.0/projects/${projectId}/tasks`
      + `?opt_fields=name,assignee.name,created_at,completed,completed_at&limit=100`
      + (ptOffset ? `&offset=${ptOffset}` : '');
    const ptRes = await fetchJson(ptUrl, { Authorization: `Bearer ${token}` });
    allProjectTasks = allProjectTasks.concat(ptRes.data || []);
    if (ptRes.next_page?.offset) { ptOffset = ptRes.next_page.offset; } else break;
  }

  const trackingSections = sections.filter(s => TRACKING_SECTIONS.has(s.name));
  const now = Date.now();
  const allTasks = [];

  // ★ 撈「裝機結案」section：含已完成任務、分頁全撈
  const dealSection = sections.find(s => s.name === DEAL_SECTION);
  let dealTasks = [];
  if (dealSection) {
    let dOffset = '';
    while (true) {
      const durl = `https://app.asana.com/api/1.0/sections/${dealSection.gid}/tasks`
        + `?opt_fields=name,assignee.name,due_on,created_at,completed,completed_at&limit=100`
        + (dOffset ? `&offset=${dOffset}` : '');
      const dres = await fetchJson(durl, { Authorization: `Bearer ${token}` });
      dealTasks = dealTasks.concat(dres.data || []);
      if (dres.next_page?.offset) { dOffset = dres.next_page.offset; } else break;
    }
    console.log(`  Section「${DEAL_SECTION}」：${dealTasks.length} 筆（含已完成）`);
  }

  // 其他追蹤中的 sections：排除已完成
  for (const sec of trackingSections) {
    if (sec.name === DEAL_SECTION) continue;
    const url = `https://app.asana.com/api/1.0/sections/${sec.gid}/tasks?opt_fields=completed,name,assignee.name,modified_at,created_at,due_on&limit=100`;
    const res = await fetchJson(url, { Authorization: `Bearer ${token}` });
    const tasks = (res.data || []).filter(t => !t.completed).map(t => ({ ...t, sectionName: sec.name }));
    allTasks.push(...tasks);
    console.log(`  Section「${sec.name}」：${tasks.length} 筆`);
  }

  // 候選逾期 task（全部都查，無 80 筆限制）
  const candidates = allTasks
    .filter(t => Math.floor((now - new Date(t.modified_at || t.created_at).getTime()) / 86400000) >= 10);
  console.log(`  候選逾期任務數：${candidates.length}`);

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
      created_at: task.created_at || null,
    };
    result[name].tracking.push(taskInfo);
    if (daysSince >= OVERDUE_DAYS && !NON_OVERDUE_SECTIONS.has(task.sectionName)) result[name].overdue.push(taskInfo);
  }
  return { result, dealTasks, allTasks, allProjectTasks };
}

async function fetchAlloc() {
  const { token, projectIds } = CFG.asana;
  if (!token) { console.warn('⚠️  Asana 未設定，跳過分配資料'); return {}; }
  console.log('📥 撈取分配儀表板資料...');
  const nameMap = CFG.nameMap;

  const results = await Promise.all(
    projectIds.map(id => fetchAllocProject(token, id, nameMap))
  );

  const allDealTasks = results.flatMap(r => r.dealTasks);
  const allTasksMap = {};
  results.forEach(r => {
    r.allProjectTasks.forEach(t => {
      const rawName = t.assignee?.name;
      if (!rawName) return;
      const name = nameMap[rawName] || Object.entries(nameMap).find(([k]) => rawName.includes(k))?.[1] || rawName;
      if (!allTasksMap[name]) allTasksMap[name] = [];
      allTasksMap[name].push(t);
    });
  });

  const merged = {};
  results.forEach(r => {
    Object.entries(r.result).forEach(([name, data]) => {
      if (!merged[name]) merged[name] = { tracking: [], overdue: [] };
      data.tracking.forEach(t => {
        if (!merged[name].tracking.some(x => x.gid === t.gid)) merged[name].tracking.push(t);
      });
      data.overdue.forEach(t => {
        if (!merged[name].overdue.some(x => x.gid === t.gid)) merged[name].overdue.push(t);
      });
    });
  });

  const now = Date.now();
  const halfYearAgo = now - HALF_YEAR_MS;
  const final = {};

  Object.entries(merged).forEach(([name, data]) => {
    const statusCount = {};
    data.tracking.forEach(t => {
      statusCount[t.section] = (statusCount[t.section] || 0) + 1;
    });

    // 逾期列表（全部列出，依天數降序）
    const overdueList = data.overdue
      .sort((a, b) => b.daysSince - a.daysSince)
      .map(t => ({
        id: t.id,
        loc: t.name.slice(0, 30),
        days: t.daysSince,
        status: t.section,
      }));

    // 各狀態清單（全部列出，依天數降序）
    const makeList = (section) => data.tracking
      .filter(t => t.section === section)
      .sort((a,b) => b.daysSince - a.daysSince)
      .map(t => ({ id: t.id, loc: t.name.slice(0, 30), days: t.daysSince, url: `https://app.asana.com/0/${t.gid}/${t.gid}` }));

    const hqKw = CFG.asana.hqKeywords;

    // visitCount：半年內所有任務（排除總部分店）
    const visitCount = (allTasksMap[name] || []).filter(t => {
      if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
      return new Date(t.created_at||0).getTime() >= halfYearAgo;
    }).length;

    const now2 = new Date();
    const thisMonthStart = new Date(Date.UTC(now2.getUTCFullYear(), now2.getUTCMonth(), 1));

    const allTasksForMonth = [
      ...(allTasksMap[name] || []),
      ...allDealTasks.filter(t => {
        const rawName = t.assignee?.name;
        if (!rawName) return false;
        const pName = nameMap[rawName] || Object.entries(nameMap).find(([k]) => rawName.includes(k))?.[1];
        return pName === name;
      })
    ];

    // ★ dealCount：「裝機結案」section 的任務（含已完成）
    // 用 completed_at / due_on / created_at 任一日期判定半年內
    const dealCount = allDealTasks.filter(t => {
      const rawName = t.assignee?.name;
      if (!rawName) return false;
      const pName = nameMap[rawName] || Object.entries(nameMap).find(([k])=>rawName.includes(k))?.[1];
      if (pName !== name) return false;
      if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
      const dateStr = t.completed_at || t.due_on || t.created_at;
      if (!dateStr) return false;
      const ts = new Date(dateStr).getTime();
      return ts >= halfYearAgo && ts <= now;
    }).length;

    const thisMonthList = allTasksForMonth
      .filter(t => {
        if (hqKw.some(kw => (t.name||'').includes(kw))) return false;
        return new Date(t.created_at||0).getTime() >= thisMonthStart.getTime();
      })
      .map(t => ({
        id: (t.name||'').split('/')[0]?.trim() || t.gid,
        loc: (t.name||'').slice(0, 30),
        created_at: t.created_at,
      }));

    const thisMonth = thisMonthList.length;
    const dealRate = visitCount > 0 ? Math.round(dealCount / visitCount * 1000) / 10 : null;

    final[name] = {
      thisMonthList,
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

    console.log(`  ${name}：visit=${visitCount}, deal=${dealCount}, rate=${dealRate}%`);
  });

  console.log('✅ 分配資料完成，業務：', Object.keys(final).join(', '));
  return final;
}

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
