import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, copyFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = __dirname;
const worldbookSrc = join(projectDir, 'worldbook_clean');
const worldbookDst = join(projectDir, '.pi', 'worldbook');
const statePath = join(projectDir, '.pi', 'state.json');

// === 1. 复制世界书（清理文件名中的多余空格） ===
function cleanName(name) {
  // 去掉文件名中连续的多个空格，替换为单个空格
  return name.replace(/ +/g, ' ').trim();
}

function copyDir(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src)) {
    const clean = cleanName(f);
    const s = join(src, f);
    const d = join(dst, clean);
    if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
      if (f !== clean) {
        console.log(`  清理文件名: ${f} → ${clean}`);
      }
    }
  }
}
copyDir(worldbookSrc, worldbookDst);
console.log('✅ 世界书已复制到 .pi/worldbook/（文件名已规范化）');

// === 2. 解析伪YAML → JSON ===
function parseYamlLike(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ obj: root, indent: -1 }];

  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const content = trimmed.trimStart();
    const match = content.match(/^([^:]+?):\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim().replace(/'/g, '');
    const value = match[2].trim().replace(/'/g, '');

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (value === '') {
      const newObj = {};
      stack[stack.length - 1].obj[key] = newObj;
      stack.push({ obj: newObj, indent });
    } else {
      let parsed = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (/^\d+$/.test(value)) parsed = parseInt(value);
      stack[stack.length - 1].obj[key] = parsed;
    }
  }
  return root;
}

// === 3. 读取所有初始状态文件 ===
const initDir = join(worldbookSrc, '角色初始状态');
const state = {};

for (const f of readdirSync(initDir)) {
  const content = readFileSync(join(initDir, f), 'utf-8');
  const yamlMatch = content.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) continue;

  // Extract name
  let name = f.replace('.md', '');
  // Handle the weird filename with quotes
  const nameMatch = content.match(/^#\s*(.+?)\s*-\s*初始/);
  if (nameMatch) {
    name = nameMatch[1].trim().replace(/'/g, '');
  }

  const data = parseYamlLike(yamlMatch[1]);
  state[name] = data;
}

// === 4. 构建核心6人初始状态 ===
const coreChars = ['夏小雀', '宁正棠', '江璃', '许知意', '林初夏', '凌晓青'];
const finalState = {
  世界: state['世界'] || { 当前日期: '2333-09-10', 当前星期: '星期一', 当前时间: '07:30', 当前位置: '学校' },
  '{{user}}': state['{{user}}'] || {},
};

for (const name of coreChars) {
  finalState[name] = state[name] || { 基本信息: { 姓名: name } };
}

finalState['_meta'] = {
  version: 2,
  lastUpdated: new Date().toISOString(),
  trackedCharacters: coreChars,
  route: '',
  routeOptions: ['纯爱线', '核心线'],
  started: false,
};

writeFileSync(statePath, JSON.stringify(finalState, null, 2), 'utf-8');
console.log(`✅ state.json 已生成 (${Object.keys(finalState).length} 个条目: 世界, user, ${coreChars.join(', ')})`);
console.log(`📂 位置: ${statePath}`);
