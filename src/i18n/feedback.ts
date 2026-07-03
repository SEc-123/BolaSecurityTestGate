import { hasTranslation, translateMessage } from './catalog';
import { I18N_STORAGE_KEY, isSupportedLanguage, type Language } from './types';

type RuntimePattern = {
  match: RegExp;
  zh: (match: RegExpMatchArray) => string;
  en?: (match: RegExpMatchArray) => string;
};

const PHRASES: Record<string, string> = {
  'Unknown error': '未知错误',
  'Name': '名称',
  'name': '名称',
  'Account name': '账号名称',
  'field name': '字段名称',
  'field name and value': '字段名称和值',
  'at least one payload': '至少一个 payload',
  'at least one value': '至少一个值',
  'at least one API template': '至少一个 API 模板',
  'at least one template or workflow': '至少一个模板或工作流',
  'an environment': '一个环境',
  'a workflow': '一个工作流',
  'a search pattern': '搜索模式',
  'a target account': '目标账号',
  'both account and environment': '账号和环境',
  'a recording session': '一个录制会话',
  'which workflow from the suite should run': '套件中要运行的工作流',
  'the current field edit first': '当前正在编辑的字段',
  'or cancel the field you are editing first': '或先取消当前字段编辑',
  'all required fields': '所有必填字段',
  'workflow': '工作流',
  'template': '模板',
  'provider': '提供方',
  'suite': '套件',
  'security rule': '安全规则',
  'checklist': '检查清单',
  'Checklist name': '检查清单名称',
  'drop rule': '丢弃规则',
  'suppression rule': '抑制规则',
  'gate policy': '门禁策略',
  'test run': '测试运行',
  'finding': '发现项',
  'variable': '变量',
  'mapping': '映射',
  'environment': '环境',
  'API draft': 'API 草稿',
  'API template': 'API 模板',
  'formal test run': '正式测试运行',
  'recording session': '录制会话',
  'recording detail': '录制详情',
  'recording timeline': '录制时间线',
  'recording center': '录制中心',
  'workflow draft': '工作流草稿',
  'API test draft': 'API 测试草稿',
  'account': '账号',
  'account draft': '账号草稿',
  'imported account': '导入账号',
  'account capture session': '账号捕获会话',
  'configuration': '配置',
  'policy': '策略',
  'preconfigured runs workspace': '预配置运行工作区',
  'reusable failure template': '可复用失败模板',
  'reusable account binding template': '可复用账号绑定模板',
  'recording dead letter': '录制死信',
};

const ACTIONS: Record<string, string> = {
  create: '创建',
  save: '保存',
  delete: '删除',
  load: '加载',
  update: '更新',
  execute: '执行',
  run: '运行',
  open: '打开',
  apply: '应用',
  parse: '解析',
  generate: '生成',
  publish: '发布',
  promote: '提升',
  export: '导出',
  retry: '重试',
  discard: '丢弃',
  toggle: '切换',
  trigger: '触发',
  regenerate: '重新生成',
  finish: '完成',
};

const RUNTIME_PATTERNS: readonly RuntimePattern[] = [
  {
    match: /^Failed to ([^:]+): ([\s\S]+)$/i,
    zh: match => `未能${translateAction(match[1])}：${translateRuntimeDetail(match[2], 'zh')}`,
  },
  {
    match: /^Failed to ([\s\S]+)$/i,
    zh: match => `未能${translateAction(match[1])}`,
  },
  {
    match: /^(.+) failed: ([\s\S]+)$/i,
    zh: match => `${translatePhrase(match[1], 'zh')}失败：${translateRuntimeDetail(match[2], 'zh')}`,
  },
  {
    match: /^(.+) failed$/i,
    zh: match => `${translatePhrase(match[1], 'zh')}失败`,
  },
  {
    match: /^(.+) is required\.?$/i,
    zh: match => `${translatePhrase(match[1], 'zh')}为必填项`,
  },
  {
    match: /^Both (.+) are required\.?$/i,
    zh: match => `${translatePhrase(match[1], 'zh')}均为必填项`,
  },
  {
    match: /^Please select ([\s\S]+)$/i,
    zh: match => `请选择${translatePhrase(match[1], 'zh')}`,
  },
  {
    match: /^Please enter ([\s\S]+)$/i,
    zh: match => `请输入${translatePhrase(match[1], 'zh')}`,
  },
  {
    match: /^Choose ([\s\S]+)$/i,
    zh: match => `请选择${translatePhrase(match[1], 'zh')}`,
  },
  {
    match: /^Delete this ([^?]+)\?$/i,
    zh: match => `删除这个${translatePhrase(match[1], 'zh')}？`,
  },
  {
    match: /^Delete\?$/i,
    zh: () => '确定删除？',
  },
  {
    match: /^Are you sure\?$/i,
    zh: () => '确定要继续吗？',
  },
  {
    match: /^Are you sure you want to delete this ([^?]+)\?$/i,
    zh: match => `确定要删除这个${translatePhrase(match[1], 'zh')}吗？`,
  },
  {
    match: /^Validation errors:\n([\s\S]+)$/i,
    zh: match => `校验错误：\n${translateRuntimeDetail(match[1], 'zh')}`,
  },
  {
    match: /^Analysis complete!\nCompleted: (\d+)\nFailed: (\d+)\nSkipped: (\d+)$/i,
    zh: match => `分析完成！\n已完成：${match[1]}\n失败：${match[2]}\n已跳过：${match[3]}`,
  },
  {
    match: /^Successfully updated (\d+) variables across (\d+) templates$/i,
    zh: match => `已成功更新 ${match[1]} 个变量，覆盖 ${match[2]} 个模板`,
  },
  {
    match: /^Imported (\d+) variable configuration\(s\) from templates\.$/i,
    zh: match => `已从模板导入 ${match[1]} 个变量配置。`,
  },
  {
    match: /^No accounts have the field "([^"]+)"$/i,
    zh: match => `没有账号包含字段 "${match[1]}"`,
  },
  {
    match: /^Account saved(?:: ([\s\S]+))?$/i,
    zh: match => match[1] ? `账号已保存：${match[1]}` : '账号已保存',
  },
  {
    match: /^Test run "([^"]+)" has started\.$/i,
    zh: match => `测试运行 "${match[1]}" 已启动。`,
  },
  {
    match: /^Preset "([^"]+)" has started running in Test Runs\.$/i,
    zh: match => `预设 "${match[1]}" 已在测试运行中启动。`,
  },
  {
    match: /^Workflow draft "([^"]+)" has been (published|updated)\.$/i,
    zh: match => `工作流草稿 "${match[1]}" 已${match[2] === 'published' ? '发布' : '更新'}。`,
  },
  {
    match: /^API draft "([^"]+)" has been published as a reusable preset\.$/i,
    zh: match => `API 草稿 "${match[1]}" 已发布为可复用预设。`,
  },
  {
    match: /^API draft "([^"]+)" has been updated\.$/i,
    zh: match => `API 草稿 "${match[1]}" 已更新。`,
  },
  {
    match: /^API template "([^"]+)" has been created from "([^"]+)"\.$/i,
    zh: match => `API 模板 "${match[1]}" 已从 "${match[2]}" 创建。`,
  },
  {
    match: /^Published template and preset from ([\s\S]+)$/i,
    zh: match => `已从 ${match[1]} 发布模板和预设`,
  },
  {
    match: /^Saved template from ([\s\S]+)$/i,
    zh: match => `已从 ${match[1]} 保存模板`,
  },
  {
    match: /^Created and started formal test run from ([\s\S]+)$/i,
    zh: match => `已从 ${match[1]} 创建并启动正式测试运行`,
  },
];

function currentDocumentLanguage(): Language {
  if (typeof document !== 'undefined') {
    const value = document.documentElement.dataset.language || document.documentElement.lang;
    if (isSupportedLanguage(value)) return value;
    if (value?.toLowerCase().startsWith('zh')) return 'zh';
  }
  return 'en';
}

export function getCurrentLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  try {
    const stored = window.localStorage.getItem(I18N_STORAGE_KEY);
    if (isSupportedLanguage(stored)) return stored;
  } catch {
  }
  return currentDocumentLanguage();
}

function translatePhrase(value: string, language: Language): string {
  const trimmed = value.trim();
  if (hasTranslation(trimmed)) return translateMessage(trimmed, language);
  if (language !== 'zh') return trimmed;

  let translated = trimmed;
  for (const [source, target] of Object.entries(PHRASES).sort((a, b) => b[0].length - a[0].length)) {
    translated = translated.replace(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), target);
  }
  return translated;
}

function translateAction(value: string): string {
  const normalized = value.trim().toLowerCase();
  for (const [source, target] of Object.entries(ACTIONS)) {
    if (normalized === source || normalized.startsWith(`${source} `)) {
      const object = normalized === source ? '' : value.trim().slice(source.length).trim();
      return `${target}${object ? translatePhrase(object, 'zh') : ''}`;
    }
  }
  return translatePhrase(value, 'zh');
}

function translateRuntimeDetail(value: string, language: Language): string {
  if (language !== 'zh') return value;
  return value
    .split('\n')
    .map(line => translateMessage(translatePhrase(line, language), language))
    .join('\n');
}

export function translateRuntimeMessage(message: unknown, language: Language = getCurrentLanguage()): string {
  const text = String(message ?? '').trim();
  if (!text) return '';
  if (hasTranslation(text)) return translateMessage(text, language);
  for (const pattern of RUNTIME_PATTERNS) {
    const match = text.match(pattern.match);
    if (match) {
      return language === 'zh' ? pattern.zh(match) : (pattern.en ? pattern.en(match) : text);
    }
  }
  return translateMessage(translateRuntimeDetail(text, language), language);
}

export function i18nAlert(message: unknown): void {
  const translated = translateRuntimeMessage(message);
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('bstg:feedback', {
    detail: {
      kind: 'info',
      message: translated,
    },
  }));
}

export function i18nConfirm(message: unknown): boolean {
  const translated = translateRuntimeMessage(message);
  if (typeof window === 'undefined') return false;
  return window.confirm(translated);
}
