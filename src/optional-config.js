'use strict';
/**
 * Explicit, single-key, reversible TOML configuration helper for ~/.codex/config.toml.
 * NEVER invoked automatically by launchers or diagnostics; requires explicit user command.
 * Preserves comments, formatting, and any subsequent edits made by the user on restore.
 */

const fs = require('fs');
const path = require('path');

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatTomlValue(val) {
  if (typeof val === 'boolean' || typeof val === 'number') return String(val);
  return JSON.stringify(String(val));
}

function locateTomlKey(lines, section, key) {
  const keyRe = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=\\s*(.*)$`);
  const targetSection = section ? String(section).trim() : '';
  let currentSection = '';
  let sectionHeaderIdx = -1;
  let sectionEndIdx = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.replace(/#.*$/, '').trim();
    const secMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (secMatch) {
      if (currentSection === targetSection && sectionHeaderIdx !== -1 && sectionEndIdx === lines.length) {
        sectionEndIdx = i;
      }
      currentSection = secMatch[1].trim();
      if (currentSection === targetSection && sectionHeaderIdx === -1) {
        sectionHeaderIdx = i;
      }
      continue;
    }
    if (currentSection === targetSection) {
      const m = raw.match(keyRe);
      if (m) {
        return {
          found: true,
          lineIndex: i,
          originalLine: raw,
          sectionHeaderIdx,
          sectionEndIdx
        };
      }
    }
  }
  return {
    found: false,
    lineIndex: -1,
    originalLine: null,
    sectionHeaderIdx,
    sectionEndIdx
  };
}

function computeTomlKeyMerge(content, section, key, value) {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = content.endsWith('\n') || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const newLine = `${key} = ${formatTomlValue(value)}`;
  const loc = locateTomlKey(lines, section, key);

  let updatedLines;
  let action;
  if (loc.found) {
    updatedLines = [...lines];
    updatedLines[loc.lineIndex] = newLine;
    action = loc.originalLine === newLine ? 'unchanged' : 'updated';
  } else if (loc.sectionHeaderIdx !== -1) {
    updatedLines = [...lines];
    updatedLines.splice(loc.sectionEndIdx, 0, newLine);
    action = 'inserted_in_section';
  } else if (section) {
    updatedLines = [...lines];
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim() !== '') {
      updatedLines.push('');
    }
    updatedLines.push(`[${section}]`);
    updatedLines.push(newLine);
    action = 'created_section_and_key';
  } else {
    updatedLines = [newLine, ...lines];
    action = 'inserted_root';
  }

  const nextContent = updatedLines.join(eol) + (hadTrailingNewline ? eol : '');
  return {
    action,
    section: section || '',
    key,
    newLine,
    previousExisted: loc.found,
    previousLine: loc.originalLine,
    nextContent
  };
}

function previewTomlKeyChange(filePath, section, key, value, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(filePath);
  const exists = fsImpl.existsSync(resolved);
  const currentContent = exists ? fsImpl.readFileSync(resolved, 'utf8') : '';
  const merged = computeTomlKeyMerge(currentContent, section, key, value);
  return {
    filePath: resolved,
    fileExists: exists,
    section: merged.section,
    key,
    action: merged.action,
    previousExisted: merged.previousExisted,
    previousLine: merged.previousLine,
    newLine: merged.newLine,
    nextContent: merged.nextContent
  };
}

function applyTomlKeyChange(filePath, section, key, value, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(filePath);
  const stateFile = path.resolve(options.stateFile || `${resolved}.codex-notun-state.json`);
  const backupDir = path.resolve(options.backupDir || path.join(path.dirname(stateFile), 'backups'));

  const fileExistedBefore = fsImpl.existsSync(resolved);
  const currentContent = fileExistedBefore ? fsImpl.readFileSync(resolved, 'utf8') : '';
  const merged = computeTomlKeyMerge(currentContent, section, key, value);

  let existingOriginState = null;
  if (fsImpl.existsSync(stateFile)) {
    try {
      const prev = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
      if (prev && prev.targetPath === resolved && prev.section === (section || '') && prev.key === key) {
        existingOriginState = prev;
      }
    } catch {}
  }

  let backupPath = existingOriginState?.backupPath || null;
  if (fileExistedBefore && !backupPath) {
    fsImpl.mkdirSync(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(backupDir, `${path.basename(resolved)}.${stamp}.bak`);
    fsImpl.writeFileSync(backupPath, currentContent, 'utf8');
  }

  fsImpl.mkdirSync(path.dirname(stateFile), { recursive: true });
  const statePayload = {
    schemaVersion: 1,
    targetPath: resolved,
    section: section || '',
    key,
    fileExistedBefore: existingOriginState ? existingOriginState.fileExistedBefore : fileExistedBefore,
    previousExisted: existingOriginState ? existingOriginState.previousExisted : merged.previousExisted,
    previousLine: existingOriginState ? existingOriginState.previousLine : merged.previousLine,
    appliedLine: merged.newLine,
    backupPath,
    appliedAt: new Date().toISOString()
  };
  const tmpState = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpState, JSON.stringify(statePayload, null, 2) + '\n', 'utf8');
  fsImpl.renameSync(tmpState, stateFile);

  fsImpl.mkdirSync(path.dirname(resolved), { recursive: true });
  const tmpTarget = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpTarget, merged.nextContent, 'utf8');
  fsImpl.renameSync(tmpTarget, resolved);

  return {
    ok: true,
    action: merged.action,
    filePath: resolved,
    stateFile,
    backupPath,
    previousLine: merged.previousLine,
    appliedLine: merged.newLine
  };
}

/**
 * Restore ONLY the single key managed by applyTomlKeyChange, keeping all other user edits made afterward.
 */
function restoreTomlKeyChange(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const resolved = path.resolve(filePath);
  const stateFile = path.resolve(options.stateFile || `${resolved}.codex-notun-state.json`);
  if (!fsImpl.existsSync(stateFile)) {
    return { ok: false, error: `未找到可恢复的状态记录：${stateFile}` };
  }
  const state = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
  if (!fsImpl.existsSync(resolved)) {
    return { ok: false, error: `目标配置文件不存在：${resolved}` };
  }

  const content = fsImpl.readFileSync(resolved, 'utf8');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingNewline = content.endsWith('\n') || content.length === 0;
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const loc = locateTomlKey(lines, state.section, state.key);
  let outcome = 'already_clean';
  if (loc.found) {
    if (state.previousExisted && typeof state.previousLine === 'string') {
      lines[loc.lineIndex] = state.previousLine;
      outcome = 'restored_previous_value';
    } else {
      lines.splice(loc.lineIndex, 1);
      // If we left behind an empty [section] header created solely for this key, clean it up cleanly
      if (loc.sectionHeaderIdx !== -1) {
        const nextLine = lines[loc.sectionHeaderIdx + 1];
        const isSectionEmpty = nextLine === undefined || /^\[[^\]]+\]$/.test(nextLine.trim()) || nextLine.trim() === '';
        if (isSectionEmpty && !state.previousExisted) {
          lines.splice(loc.sectionHeaderIdx, 1);
          if (loc.sectionHeaderIdx > 0 && lines[loc.sectionHeaderIdx - 1] === '' && lines[loc.sectionHeaderIdx] === undefined) {
            lines.pop();
          }
        }
      }
      outcome = 'removed_added_key';
    }
  }

  const restoredContent = lines.length === 0 ? '' : (lines.join(eol) + (hadTrailingNewline ? eol : ''));
  const tmpTarget = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  fsImpl.writeFileSync(tmpTarget, restoredContent, 'utf8');
  fsImpl.renameSync(tmpTarget, resolved);
  try { fsImpl.unlinkSync(stateFile); } catch {}

  return {
    ok: true,
    outcome,
    filePath: resolved,
    section: state.section,
    key: state.key,
    backupPath: state.backupPath || null
  };
}

module.exports = {
  computeTomlKeyMerge,
  previewTomlKeyChange,
  applyTomlKeyChange,
  restoreTomlKeyChange
};
