import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearPresetEnhanceUnavailableReason, isPresetEnhanceActive, markPresetEnhanceActive,
  presetEnhanceUnavailableReason, PRESET_ENHANCE_INACTIVE_REASON, setPresetEnhanceUnavailableReason,
} from '../lib/availability.mjs';
import { apply as applyMode, name as modeName } from '../mode.mjs';

test('the generated preset mode refuses to mount while the host plugin is inactive', () => {
  assert.equal(isPresetEnhanceActive(), false);
  assert.throws(() => applyMode(), /预设增强插件未启用/);
  const release = markPresetEnhanceActive();
  assert.equal(isPresetEnhanceActive(), true);
  assert.doesNotThrow(() => applyMode());
  release();
  assert.equal(isPresetEnhanceActive(), false);
  assert.throws(() => applyMode(), /预设增强插件未启用/);
});

test('availability marking is counted and each release is idempotent', () => {
  const outer = markPresetEnhanceActive();
  const inner = markPresetEnhanceActive();
  outer();
  outer();
  assert.equal(isPresetEnhanceActive(), true, 'releasing an inner activation must not clear an outer one');
  inner();
  assert.equal(isPresetEnhanceActive(), false);
});

test('a startup failure is reported by the mode instead of the generic reason', () => {
  assert.equal(isPresetEnhanceActive(), false);
  setPresetEnhanceUnavailableReason('预设工作台初始化失败：无法读取状态文件 /tmp/state.json');
  try {
    assert.throws(() => applyMode(), /无法读取状态文件/);
  } finally {
    clearPresetEnhanceUnavailableReason();
  }
  assert.equal(presetEnhanceUnavailableReason(), PRESET_ENHANCE_INACTIVE_REASON);
  assert.throws(() => applyMode(), /预设增强插件未启用/);
});

test('the inactive reason names the plugin and the recovery path', () => {
  assert.match(PRESET_ENHANCE_INACTIVE_REASON, /dsh-preset-enhance/);
  assert.match(PRESET_ENHANCE_INACTIVE_REASON, /启用/);
  assert.equal(modeName, 'preset-enhance-mode');
});
