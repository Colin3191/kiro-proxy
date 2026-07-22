import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAnthropicModelOptions,
  normalizeResponsesModelOptions,
  resolveAdditionalModelRequestFields,
} from '../model-options.js';

const claudeSchema = {
  type: 'object',
  properties: {
    thinking: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['adaptive', 'disabled'] },
        display: { type: 'string', enum: ['summarized', 'omitted'] },
      },
      required: ['type'],
    },
    output_config: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'], default: 'high' },
      },
    },
  },
};

const gptSchema = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'object',
      properties: {
        effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
      },
    },
  },
};

test('Responses reasoning.effort 根据 GPT schema 映射到 reasoning', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'xhigh' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(gptSchema, normalized), {
    reasoning: { effort: 'xhigh' },
  });
});

test('Responses reasoning.effort 根据 Claude schema 映射到 output_config', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'medium' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    output_config: { effort: 'medium' },
  });
});

test('Claude 不支持 xhigh 时回退到模型默认 effort', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'xhigh' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    output_config: { effort: 'high' },
  });
});

test('Responses none 对 Claude 转换为关闭 thinking', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'none' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    thinking: { type: 'disabled' },
  });
});

test('Responses minimal 映射为 GPT none 或 Claude low', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'minimal' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(gptSchema, normalized), {
    reasoning: { effort: 'none' },
  });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    output_config: { effort: 'low' },
  });
});

test('Anthropic output_config.effort 复用相同映射', () => {
  const normalized = normalizeAnthropicModelOptions({ output_config: { effort: 'max' } });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    output_config: { effort: 'max' },
  });
  assert.deepEqual(resolveAdditionalModelRequestFields(gptSchema, normalized), {
    reasoning: { effort: 'max' },
  });
});

test('Anthropic thinking 映射启用状态、展示方式和预算档位', () => {
  const normalized = normalizeAnthropicModelOptions({
    thinking: { type: 'enabled', display: 'omitted', budget_tokens: 12000 },
  });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort: 'high' },
  });
});

test('显式 output_config.effort 优先于 budget_tokens 推导值', () => {
  const normalized = normalizeAnthropicModelOptions({
    output_config: { effort: 'low' },
    thinking: { type: 'adaptive', budget_tokens: 64000 },
  });
  assert.deepEqual(resolveAdditionalModelRequestFields(claudeSchema, normalized), {
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
  });
});

test('模型没有 additionalModelRequestFieldsSchema 时不发送字段', () => {
  const normalized = normalizeResponsesModelOptions({ reasoning: { effort: 'high' } });
  assert.equal(resolveAdditionalModelRequestFields(null, normalized), undefined);
});

