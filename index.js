#!/usr/bin/env node

import { readFileSync, existsSync, writeFileSync, appendFileSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

// ─── ANSI colours ────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  dim:    '\x1b[2m',
  white:  '\x1b[37m',
};

const fmt = {
  critical: (s) => `${c.bold}${c.red}${s}${c.reset}`,
  warning:  (s) => `${c.bold}${c.yellow}${s}${c.reset}`,
  info:     (s) => `${c.bold}${c.green}${s}${c.reset}`,
  dim:      (s) => `${c.dim}${s}${c.reset}`,
  bold:     (s) => `${c.bold}${s}${c.reset}`,
  cyan:     (s) => `${c.cyan}${s}${c.reset}`,
};

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  fix:      args.includes('--fix'),
  diff:     args.includes('--diff'),
  generate: args.includes('--generate'),
  help:     args.includes('--help') || args.includes('-h'),
  noColor:  args.includes('--no-color') || !process.stdout.isTTY,
};

// Positional arg = path to .env file or directory
const positional = args.find(a => !a.startsWith('--') && !a.startsWith('-'));

if (flags.noColor) {
  Object.keys(c).forEach(k => { c[k] = ''; });
}

if (flags.help) {
  console.log(`
${fmt.bold('env-doctor')} — Audit your .env files before it's too late.

${fmt.bold('Usage')}
  env-doctor                    Audit .env in current directory
  env-doctor path/to/.env       Audit specific file
  env-doctor path/to/dir        Audit .env in directory

${fmt.bold('Flags')}
  --fix        Auto-fix safe issues (add .env to .gitignore, generate .env.example)
  --diff       Show diff between .env and .env.example
  --generate   Generate .env.example from .env (strips real values, keeps keys)
  --no-color   Disable colour output
  --help, -h   Show this help

${fmt.bold('Checks')}
  🔴 Critical  .env committed to git, not in .gitignore, real-looking secrets,
               default/placeholder values, exposed token patterns
  🟡 Warning   Missing .env.example, variable mismatches, empty values,
               values equal to var name, trailing whitespace
  🟢 Info      Missing comments, framework-specific recommendations
`);
  process.exit(0);
}

// ─── Resolve paths ────────────────────────────────────────────────────────────
function resolvePaths(input) {
  if (!input) {
    return {
      envFile:     resolve(process.cwd(), '.env'),
      envExample:  resolve(process.cwd(), '.env.example'),
      gitignore:   resolve(process.cwd(), '.gitignore'),
      packageJson: resolve(process.cwd(), 'package.json'),
      projectDir:  process.cwd(),
    };
  }

  const abs = resolve(process.cwd(), input);

  // Is it a file?
  if (existsSync(abs) && !abs.endsWith('/') && basename(abs).startsWith('.env')) {
    const dir = dirname(abs);
    return {
      envFile:     abs,
      envExample:  join(dir, '.env.example'),
      gitignore:   join(dir, '.gitignore'),
      packageJson: join(dir, 'package.json'),
      projectDir:  dir,
    };
  }

  // Treat as directory
  const dir = abs;
  return {
    envFile:     join(dir, '.env'),
    envExample:  join(dir, '.env.example'),
    gitignore:   join(dir, '.gitignore'),
    packageJson: join(dir, 'package.json'),
    projectDir:  dir,
  };
}

const paths = resolvePaths(positional);

// ─── Parse .env file ──────────────────────────────────────────────────────────
function parseEnv(filePath) {
  if (!existsSync(filePath)) return null;

  const lines = readFileSync(filePath, 'utf8').split('\n');
  const vars = {};
  const comments = {};
  const raw = [];

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    raw.push({ line, lineNo });

    const trimmed = line.trim();

    if (trimmed.startsWith('#') || trimmed === '') return;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return;

    const key = line.slice(0, eqIdx).trim();
    const value = line.slice(eqIdx + 1); // preserve raw value for trailing space detection

    if (!key || key.includes(' ')) return;

    vars[key] = { value: value.replace(/\n$/, ''), rawValue: value, lineNo };

    // Check if line above is a comment
    if (idx > 0) {
      const prev = lines[idx - 1].trim();
      if (prev.startsWith('#')) {
        comments[key] = prev;
      }
    }
  });

  return { vars, comments, raw, lineCount: lines.length };
}

// ─── Git helpers ──────────────────────────────────────────────────────────────
function isFileTrackedByGit(filePath) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', filePath], {
      cwd: dirname(filePath),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── Default value patterns ───────────────────────────────────────────────────
const DEFAULT_PATTERNS = [
  /^changeme$/i,
  /^your[-_]?api[-_]?key[-_]?(here)?$/i,
  /^change[-_]?this$/i,
  /^\bTODO\b/i,
  /^xxx+$/i,
  /^placeholder$/i,
  /^example$/i,
  /^test123$/i,
  /^password123$/i,
  /^secret123$/i,
  /^(abc|123|1234|12345|123456|1234567|12345678|87654321)$/,
  /^dummy$/i,
  /^fake$/i,
  /^sample$/i,
  /^replace[-_]?me$/i,
  /^insert[-_]?here$/i,
  /^none$/i,
  /^null$/i,
  /^undefined$/i,
  /^n\/a$/i,
  /^default$/i,
  /^temp$/i,
  /^localhost:3000$/, // not wrong but often a leftover
];

function isDefaultValue(val) {
  const v = val.trim();
  if (v === '') return false;
  return DEFAULT_PATTERNS.some(p => p.test(v));
}

// ─── Secret pattern checks (pattern matching only — never logs actual values) ──
const SECRET_PATTERNS = [
  {
    name: 'AWS access key',
    pattern: /\bAKIA[A-Z0-9]{16}\b/,
    hint: 'Matches AWS access key format (AKIA...)',
  },
  {
    name: 'GitHub personal access token (classic)',
    pattern: /\bghp_[A-Za-z0-9]{36,}\b/,
    hint: 'Matches GitHub classic PAT format (ghp_...)',
  },
  {
    name: 'GitHub fine-grained token',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/,
    hint: 'Matches GitHub fine-grained PAT format',
  },
  {
    name: 'Stripe secret key',
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/,
    hint: 'Matches Stripe live secret key format (sk_live_...)',
  },
  {
    name: 'Stripe restricted key',
    pattern: /\brk_live_[A-Za-z0-9]{24,}\b/,
    hint: 'Matches Stripe restricted live key format',
  },
  {
    name: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/,
    hint: 'Matches Anthropic API key format (sk-ant-...)',
  },
  {
    name: 'OpenAI API key',
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/,
    hint: 'Matches OpenAI API key format (sk-...)',
  },
  {
    name: 'Slack bot token',
    pattern: /\bxoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+\b/,
    hint: 'Matches Slack bot token format (xoxb-...)',
  },
  {
    name: 'Slack user token',
    pattern: /\bxoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+\b/,
    hint: 'Matches Slack user token format (xoxp-...)',
  },
  {
    name: 'Twilio account SID',
    pattern: /\bAC[a-f0-9]{32}\b/,
    hint: 'Matches Twilio Account SID format (AC...)',
  },
  {
    name: 'SendGrid API key',
    pattern: /\bSG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}\b/,
    hint: 'Matches SendGrid API key format (SG....)',
  },
  {
    name: 'Heroku API key',
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/,
    hint: 'Matches UUID-style token (could be Heroku or similar)',
    lowConfidence: true, // UUIDs are common as IDs too
  },
];

// ─── Framework detection ──────────────────────────────────────────────────────
function detectFramework(packageJsonPath) {
  if (!existsSync(packageJsonPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    if (deps['next']) return 'nextjs';
    if (deps['@remix-run/node'] || deps['@remix-run/react']) return 'remix';
    if (deps['gatsby']) return 'gatsby';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@sveltejs/kit']) return 'sveltekit';
    if (deps['vite']) return 'vite';
    if (deps['react']) return 'react';
    if (deps['express'] || deps['fastify'] || deps['koa']) return 'node-server';
    if (deps['django'] !== undefined) return 'django'; // unlikely in package.json but handled
  } catch {}
  return null;
}

const FRAMEWORK_REQUIRED_VARS = {
  nextjs: {
    vars: ['NEXTAUTH_SECRET', 'NEXTAUTH_URL'],
    hint: 'Next.js + NextAuth detected',
  },
  remix: {
    vars: ['SESSION_SECRET'],
    hint: 'Remix detected',
  },
  sveltekit: {
    vars: [],
    hint: 'SvelteKit detected — remember PUBLIC_ prefix for client-exposed vars',
  },
  nuxt: {
    vars: [],
    hint: 'Nuxt detected — remember NUXT_PUBLIC_ prefix for client-exposed vars',
  },
  'node-server': {
    vars: ['NODE_ENV', 'PORT'],
    hint: 'Node.js server detected',
  },
};

// ─── Check: gitignore ─────────────────────────────────────────────────────────
function checkGitignore(gitignorePath) {
  if (!existsSync(gitignorePath)) return false;
  const content = readFileSync(gitignorePath, 'utf8');
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.some(l => {
    // Matches: .env, *.env, .env*, .env.*, !.env.example (negative, but still covers .env)
    return l === '.env' || l === '*.env' || l === '.env*' || l === '**/.env';
  });
}

// ─── Main audit ───────────────────────────────────────────────────────────────
function runAudit() {
  const criticals = [];
  const warnings  = [];
  const infos     = [];
  const fixes     = []; // auto-fixable

  const envExists     = existsSync(paths.envFile);
  const exampleExists = existsSync(paths.envExample);

  console.log('');
  console.log(fmt.bold('🏥 .env Doctor'));
  console.log(fmt.dim('───────────────'));
  console.log(`${fmt.dim('Scanning:')} ${fmt.cyan(paths.projectDir)}`);
  console.log('');

  if (!envExists) {
    console.log(fmt.warning('No .env file found in this directory.'));
    console.log(fmt.dim('Nothing to audit. Create a .env file first.'));
    process.exit(0);
  }

  const envData     = parseEnv(paths.envFile);
  const exampleData = exampleExists ? parseEnv(paths.envExample) : null;
  const envVars     = envData.vars;
  const envKeys     = Object.keys(envVars);
  const exampleKeys = exampleData ? Object.keys(exampleData.vars) : [];

  // ── SECURITY CHECKS ────────────────────────────────────────────────────────

  // 1. Is .env committed to git?
  const inGitRepo = isGitRepo(paths.projectDir);
  if (inGitRepo && isFileTrackedByGit(paths.envFile)) {
    criticals.push({
      icon: '⚠️ ',
      title: '.env is committed to git!',
      detail: 'Anyone with repo access can see your secrets.',
      fix: `  ${fmt.dim('→')} git rm --cached .env && echo ".env" >> .gitignore\n  ${fmt.dim('→')} git commit -m "remove .env from tracking"`,
      autoFix: 'remove-from-git',
    });
  }

  // 2. .env not in .gitignore
  const envInGitignore = checkGitignore(paths.gitignore);
  if (!envInGitignore) {
    const gitignoreExists = existsSync(paths.gitignore);
    criticals.push({
      icon: '⚠️ ',
      title: '.env is not in .gitignore',
      detail: gitignoreExists
        ? '.gitignore exists but does not include .env — one accidental `git add .` away from disaster.'
        : 'No .gitignore found at all — .env could be committed on next git add.',
      fix: `  ${fmt.dim('→')} echo ".env" >> .gitignore`,
      autoFix: 'add-to-gitignore',
    });
    fixes.push('add-to-gitignore');
  }

  // 3. Default/placeholder values
  for (const [key, { value, lineNo }] of Object.entries(envVars)) {
    const stripped = value.trim();
    if (isDefaultValue(stripped)) {
      criticals.push({
        icon: '⚠️ ',
        title: `${key} uses a default/placeholder value`,
        detail: `  .env line ${lineNo}: ${key}=${fmt.dim(stripped.slice(0, 30))}${stripped.length > 30 ? '…' : ''}`,
        fix: `  ${fmt.dim('→')} Replace with a real value before deploying`,
      });
    }
  }

  // 4. Detect real-looking secret patterns
  for (const [key, { value, lineNo }] of Object.entries(envVars)) {
    const stripped = value.trim();
    if (!stripped) continue;
    for (const sp of SECRET_PATTERNS) {
      if (sp.pattern.test(stripped)) {
        const sev = sp.lowConfidence ? warnings : criticals;
        sev.push({
          icon: sp.lowConfidence ? '⚡' : '🔑',
          title: `${key} looks like a real ${sp.name}`,
          detail: `  .env line ${lineNo} — ${sp.hint}`,
          fix: `  ${fmt.dim('→')} Ensure this file is in .gitignore and never committed`,
        });
      }
    }
  }

  // 5. Same value used for multiple different-purpose keys
  const valueMap = {};
  for (const [key, { value }] of Object.entries(envVars)) {
    const v = value.trim();
    if (!v || v.length < 8) continue; // short values not worth checking
    if (!valueMap[v]) valueMap[v] = [];
    valueMap[v].push(key);
  }
  for (const [val, keys] of Object.entries(valueMap)) {
    if (keys.length >= 2) {
      // Only flag if they look like different-purpose keys
      const hasSensitive = keys.some(k =>
        /password|secret|key|token|salt|hash/i.test(k)
      );
      const allSame = keys.every(k =>
        /password|secret|key|token|salt|hash/i.test(k)
      );
      if (hasSensitive && allSame) {
        criticals.push({
          icon: '🔁',
          title: `Same value shared between: ${keys.join(', ')}`,
          detail: `  These keys share an identical value — each secret should be unique.`,
          fix: `  ${fmt.dim('→')} Generate separate secrets for each key`,
        });
      }
    }
  }

  // ── STRUCTURE CHECKS ───────────────────────────────────────────────────────

  // 6. .env exists but .env.example doesn't
  if (!exampleExists) {
    warnings.push({
      icon: '📄',
      title: '.env.example is missing',
      detail: `  ${envKeys.length} variable${envKeys.length !== 1 ? 's' : ''} are undocumented — new devs won't know what to set.`,
      fix: `  ${fmt.dim('→')} env-doctor --generate   (creates .env.example without real values)`,
      autoFix: 'generate-example',
    });
    fixes.push('generate-example');
  } else {
    // 7. Vars in .env.example but missing from .env
    const missingFromEnv = exampleKeys.filter(k => !envKeys.includes(k));
    if (missingFromEnv.length > 0) {
      warnings.push({
        icon: '❌',
        title: `Variable${missingFromEnv.length > 1 ? 's' : ''} in .env.example but missing from .env`,
        detail: missingFromEnv.map(k => `  ${fmt.dim('→')} ${k}`).join('\n'),
        fix: `  ${fmt.dim('→')} Add these to your .env file`,
      });
    }

    // 8. Vars in .env but not in .env.example
    const missingFromExample = envKeys.filter(k => !exampleKeys.includes(k));
    if (missingFromExample.length > 0) {
      warnings.push({
        icon: '📝',
        title: `Variable${missingFromExample.length > 1 ? 's' : ''} in .env but not documented in .env.example`,
        detail: missingFromExample.map(k => `  ${fmt.dim('→')} ${k}`).join('\n'),
        fix: `  ${fmt.dim('→')} Add placeholder entries to .env.example`,
      });
    }
  }

  // 9. Values that are just the variable name (KEY=KEY)
  for (const [key, { value, lineNo }] of Object.entries(envVars)) {
    if (value.trim() === key) {
      warnings.push({
        icon: '🔄',
        title: `${key} has value equal to its own name`,
        detail: `  .env line ${lineNo}: ${key}=${key}`,
        fix: `  ${fmt.dim('→')} Replace with actual value`,
      });
    }
  }

  // 10. Empty values
  for (const [key, { value, lineNo }] of Object.entries(envVars)) {
    if (value.trim() === '') {
      // Only warn if .env.example doesn't have a default value
      const exampleVal = exampleData?.vars?.[key]?.value?.trim();
      if (!exampleVal) {
        warnings.push({
          icon: '🕳️ ',
          title: `Empty value: ${key}`,
          detail: `  .env line ${lineNo}: ${key}= (blank — may cause runtime errors)`,
          fix: `  ${fmt.dim('→')} Set a value or remove if unused`,
        });
      }
    }
  }

  // 11. Trailing whitespace in values
  for (const [key, { rawValue, lineNo }] of Object.entries(envVars)) {
    // rawValue still has newline stripped but not trailing spaces
    if (rawValue !== rawValue.trimEnd()) {
      warnings.push({
        icon: '🧹',
        title: `Trailing whitespace in ${key}`,
        detail: `  .env line ${lineNo} — trailing spaces cause hard-to-debug auth failures`,
        fix: `  ${fmt.dim('→')} Remove trailing whitespace from the value`,
      });
    }
  }

  // ── BEST PRACTICE CHECKS ──────────────────────────────────────────────────

  // 12. No comments explaining variables
  const uncommentedCount = envKeys.filter(k => !envData.comments[k]).length;
  if (uncommentedCount > 2) {
    infos.push({
      icon: '💬',
      title: `${uncommentedCount} variable${uncommentedCount !== 1 ? 's' : ''} have no explanatory comments`,
      detail: `  Adding # comments above each var helps teammates understand what each key does.`,
      fix: `  ${fmt.dim('→')} Add # Description above each variable in .env.example`,
    });
  }

  // 13. Framework-specific missing vars
  const framework = detectFramework(paths.packageJson);
  if (framework && FRAMEWORK_REQUIRED_VARS[framework]) {
    const { vars: requiredVars, hint } = FRAMEWORK_REQUIRED_VARS[framework];
    const missingFrameworkVars = requiredVars.filter(v => !envKeys.includes(v));
    if (missingFrameworkVars.length > 0) {
      infos.push({
        icon: '🔧',
        title: `${hint} — consider adding: ${missingFrameworkVars.join(', ')}`,
        detail: `  These are commonly required for ${framework} projects.`,
        fix: `  ${fmt.dim('→')} Add these variables to your .env`,
      });
    }
    if (framework === 'sveltekit' || framework === 'nuxt') {
      infos.push({
        icon: '🌐',
        title: FRAMEWORK_REQUIRED_VARS[framework].hint,
        detail: `  Client-exposed vars need the correct prefix (${framework === 'sveltekit' ? 'PUBLIC_' : 'NUXT_PUBLIC_'}).`,
        fix: '',
      });
    }
  }

  // 14. NODE_ENV recommendation
  if (!envKeys.includes('NODE_ENV')) {
    infos.push({
      icon: '🌱',
      title: 'NODE_ENV is not set',
      detail: '  Many libraries change behaviour based on NODE_ENV.',
      fix: `  ${fmt.dim('→')} Add NODE_ENV=development to .env`,
    });
  }

  // ── RENDER OUTPUT ─────────────────────────────────────────────────────────

  const renderGroup = (emoji, label, colour, items) => {
    if (items.length === 0) return;
    console.log(`${colour(`${emoji} ${label} (${items.length})`)}`);
    for (const item of items) {
      console.log(`  ${item.icon} ${fmt.bold(item.title)}`);
      if (item.detail) console.log(`${fmt.dim(item.detail)}`);
      if (item.fix)    console.log(`${item.fix}`);
      console.log('');
    }
  };

  renderGroup('🔴', 'CRITICAL', fmt.critical, criticals);
  renderGroup('🟡', 'WARNINGS', fmt.warning,  warnings);
  renderGroup('🟢', 'INFO',     fmt.info,      infos);

  // ── OVERALL HEALTH ────────────────────────────────────────────────────────
  console.log(fmt.dim('━━━━━━━━━━━━━━━━━━━━━━━━━'));

  let health;
  if (criticals.length > 0) {
    health = fmt.critical('🔴 CRITICAL — fix issues above before deploying');
  } else if (warnings.length > 0) {
    health = fmt.warning('🟡 FAIR — warnings worth addressing');
  } else if (infos.length > 0) {
    health = fmt.info('🟢 GOOD — minor suggestions only');
  } else {
    health = `${c.bold}${c.green}✅ HEALTHY — nothing to report${c.reset}`;
  }

  console.log(`Overall Health: ${health}`);
  console.log('');

  if (fixes.length > 0 && !flags.fix) {
    console.log(fmt.dim(`Run ${fmt.bold('env-doctor --fix')} to auto-fix what's safe (gitignore, .env.example)`));
    console.log('');
  }

  return { criticals, warnings, infos, fixes, envData, exampleData, envKeys, exampleKeys };
}

// ─── --diff ───────────────────────────────────────────────────────────────────
function runDiff() {
  const envData     = parseEnv(paths.envFile);
  const exampleData = existsSync(paths.envExample) ? parseEnv(paths.envExample) : null;

  if (!envData) {
    console.log(fmt.warning('No .env file found.'));
    process.exit(1);
  }

  console.log('');
  console.log(fmt.bold('📊 .env vs .env.example diff'));
  console.log(fmt.dim('─────────────────────────────'));
  console.log('');

  const envKeys     = Object.keys(envData.vars);
  const exampleKeys = exampleData ? Object.keys(exampleData.vars) : [];

  if (!exampleData) {
    console.log(fmt.warning('.env.example does not exist.'));
    console.log(fmt.dim(`Run ${fmt.bold('env-doctor --generate')} to create one.`));
    process.exit(0);
  }

  const allKeys = [...new Set([...envKeys, ...exampleKeys])].sort();

  for (const key of allKeys) {
    const inEnv     = envKeys.includes(key);
    const inExample = exampleKeys.includes(key);

    if (inEnv && inExample) {
      console.log(`  ${fmt.dim('=')} ${key}`);
    } else if (inEnv && !inExample) {
      console.log(`  ${fmt.warning('+')} ${key} ${fmt.dim('(in .env, missing from .env.example)')}`);
    } else {
      console.log(`  ${fmt.critical('-')} ${key} ${fmt.dim('(in .env.example, missing from .env)')}`);
    }
  }

  console.log('');
}

// ─── --generate ───────────────────────────────────────────────────────────────
function runGenerate(envData) {
  if (!envData) {
    envData = parseEnv(paths.envFile);
    if (!envData) {
      console.log(fmt.warning('No .env file found.'));
      process.exit(1);
    }
  }

  const lines = [];
  lines.push('# .env.example — copy to .env and fill in real values');
  lines.push('# Generated by env-doctor (https://github.com/NickCirv/env-doctor)');
  lines.push('');

  let lastHadComment = false;

  for (const [key, { lineNo }] of Object.entries(envData.vars)) {
    // Preserve comments from source
    const comment = envData.comments?.[key];
    if (comment) {
      if (!lastHadComment) lines.push('');
      lines.push(comment);
      lastHadComment = true;
    } else {
      lastHadComment = false;
    }
    lines.push(`${key}=`);
  }

  lines.push('');

  const output = lines.join('\n');
  writeFileSync(paths.envExample, output, 'utf8');

  console.log('');
  console.log(fmt.info(`✅ Generated ${paths.envExample}`));
  console.log(fmt.dim(`   ${Object.keys(envData.vars).length} variables — all values stripped`));
  console.log('');
}

// ─── --fix ────────────────────────────────────────────────────────────────────
function runFix(result) {
  const { criticals, warnings, envData } = result;
  let fixed = 0;

  // Fix: add .env to .gitignore
  const needsGitignoreFix = criticals.some(c => c.autoFix === 'add-to-gitignore');
  if (needsGitignoreFix) {
    const gitignorePath = paths.gitignore;
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '.env\n', 'utf8');
      console.log(fmt.info('✅ Created .gitignore with .env entry'));
    } else {
      appendFileSync(gitignorePath, '\n.env\n');
      console.log(fmt.info('✅ Added .env to .gitignore'));
    }
    fixed++;
  }

  // Fix: generate .env.example
  const needsExampleFix = warnings.some(w => w.autoFix === 'generate-example');
  if (needsExampleFix) {
    runGenerate(envData);
    fixed++;
  }

  if (fixed === 0) {
    console.log(fmt.dim('Nothing auto-fixable found (or already fixed).'));
  } else {
    console.log('');
    console.log(fmt.dim(`${fixed} fix${fixed !== 1 ? 'es' : ''} applied. Run env-doctor again to verify.`));
  }
  console.log('');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
if (flags.diff) {
  runDiff();
} else if (flags.generate) {
  runGenerate(null);
} else {
  const result = runAudit();
  if (flags.fix) {
    console.log(fmt.bold('🔧 Applying fixes...'));
    console.log('');
    runFix(result);
  }
}
